import { randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import type { LoadEvent, LoadOptions, LoadStopReason, LoadTick, LoadTotals, RequestItem } from '../../shared/types'
import { toDispatch } from '../http/dispatchOptions'
import { Histogram } from './histogram'
import { emptySnapshot, mergeSnapshots, summary, type MetricsSnapshot, type SecondBucket } from './metrics'
import type { FromLoadWorker, ToLoadWorker, WorkerInit } from './worker'

// The main-process side of a load test: splits the virtual users over worker threads, merges the metrics snapshots
// they post every second and turns them into LoadEvents. The workers and the events' transport are injected, so this
// module touches no store and no IPC itself.
//
// Each snapshot's totals are running totals and its `seconds` hold only the seconds closed since the worker's last
// snapshot. So the global totals merge the latest snapshot of every worker, and the per-second series accumulates
// `seconds` over time, merging the workers' buckets of the same second.

export const MAX_VUS = 1000
export const MAX_DURATION_SEC = 3600
export const MAX_THINK_TIME_MS = 60_000
export const MAX_TIMEOUT_SEC = 120
export const MAX_WORKERS = 4
/** How long workers have to wind down after a stop before they are terminated. */
const STOP_GRACE_MS = 1500
/** Past the duration and the workers' own 2 s grace, how long a silent worker is waited for. */
const WATCHDOG_SLACK_MS = 5000

/** What the engine needs of a worker: `node:worker_threads`' Worker, or a stand-in in tests. */
export interface WorkerLike {
  postMessage(message: ToLoadWorker): void
  on(event: 'message', listener: (message: FromLoadWorker) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
}

export interface LoadDeps {
  spawnWorker(init: WorkerInit): WorkerLike
  emit(e: LoadEvent): void
  /** A monotonic ms clock (performance.now()); gives `durationMs` and the running rps. */
  now(): number
}

export interface LoadHandle {
  testId: string
  /** Resolves once `finished` was emitted and every worker was terminated; never rejects. */
  done: Promise<void>
  /** Aborts every worker's requests; `finished` (`stopped`) follows within STOP_GRACE_MS. A no-op once finished. */
  stop(): void
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const numberIn = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

/** Throws `invalid_load_options: <field>` for the first field that is not valid. */
export function validateLoadOptions(o: LoadOptions): void {
  const bad = (field: string): never => {
    throw new Error(`invalid_load_options: ${field}`)
  }
  if (!isRecord(o)) bad('options')
  if (typeof o.path !== 'string' || o.path === '') bad('path')
  if (o.environmentId !== null && typeof o.environmentId !== 'string') bad('environmentId')
  if (!Number.isInteger(o.vus) || !numberIn(o.vus, 1, MAX_VUS)) bad('vus')
  if (!numberIn(o.durationSec, 1, MAX_DURATION_SEC)) bad('durationSec')
  if (!numberIn(o.rampUpSec, 0, o.durationSec)) bad('rampUpSec')
  if (!numberIn(o.thinkTimeMs, 0, MAX_THINK_TIME_MS)) bad('thinkTimeMs')
  if (!numberIn(o.timeoutSec, 1, MAX_TIMEOUT_SEC)) bad('timeoutSec')
}

/** `min(4, cores - 1, VUs)`, at least 1. */
export function workerCount(vus: number): number {
  return Math.max(1, Math.min(MAX_WORKERS, availableParallelism() - 1, vus))
}

function toTick(s: SecondBucket): LoadTick {
  const h = Histogram.from(s.latency)
  return {
    t: s.t,
    rps: s.completed,
    errors: s.errors,
    activeVus: s.activeVus,
    p50: h.percentile(50),
    p95: h.percentile(95),
    p99: h.percentile(99),
  }
}

const quietSecond = (t: number): SecondBucket => ({
  t,
  completed: 0,
  errors: 0,
  activeVus: 0,
  latency: new Histogram().toData(),
})

interface Slot {
  worker: WorkerLike
  latest: MetricsSnapshot
  /** Every second before this one has been reported by this worker. */
  through: number
  done: boolean
}

/**
 * Starts a load test and emits `started` before returning. Throws before spawning anything on invalid options
 * (`invalid_load_options: <field>`), no requests (`no_requests`) or a request that cannot be sent (its message).
 * `displayUrls` (secrets masked) are what `started` shows for the requests.
 *
 * - The test ends `completed` once every worker has reported done, `stopped` after `stop()`, or `error` when a worker
 *   fails, exits early or stops answering; `message` then names the failure.
 * - `tick`s carry the seconds every worker has closed; `finished` carries all of them. Nothing follows `finished`.
 */
export function startLoad(
  deps: LoadDeps,
  resolved: { requests: RequestItem[]; displayUrls: string[] },
  options: LoadOptions,
): LoadHandle {
  validateLoadOptions(options)
  if (resolved.requests.length === 0) throw new Error('no_requests')
  const requests = resolved.requests.map((r) => toDispatch(r))
  const testId = randomUUID()
  const count = workerCount(options.vus)
  const startedAt = new Date()
  const t0 = deps.now()

  const slots: Slot[] = []
  const seconds = new Map<number, SecondBucket>()
  let ticked = 0
  let state: 'running' | 'stopping' | 'finished' = 'running'
  let stopTimer: NodeJS.Timeout | undefined
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const totals = (elapsedMs: number): LoadTotals => {
    const merged = emptySnapshot()
    for (const slot of slots) mergeSnapshots(merged, { ...slot.latest, seconds: [] })
    const { completed, errors, aborted, bytes } = merged.total
    return {
      completed,
      errors,
      aborted,
      bytes,
      ...summary(merged, elapsedMs),
      status: merged.status,
      errorCodes: merged.errors,
    }
  }

  const ticksBetween = (from: number, to: number): LoadTick[] => {
    const out: LoadTick[] = []
    for (let t = from; t < to; t++) out.push(toTick(seconds.get(t) ?? quietSecond(t)))
    return out
  }

  const finish = (reason: LoadStopReason, message?: string) => {
    if (state === 'finished') return
    state = 'finished'
    clearTimeout(stopTimer)
    clearTimeout(watchdog)
    const last = Math.max(-1, ...seconds.keys())
    const durationMs = deps.now() - t0
    deps.emit({
      testId,
      type: 'finished',
      reason,
      ...(message !== undefined && { message }),
      durationMs,
      totals: totals(durationMs),
      ticks: ticksBetween(0, last + 1),
    })
    void Promise.all(slots.map((slot) => slot.worker.terminate().catch(() => 0))).then(() => resolveDone())
  }

  const onSnapshot = (slot: Slot, snapshot: MetricsSnapshot, last: boolean) => {
    slot.latest = snapshot
    // Only the seconds this snapshot reports: merged into the buckets other workers gave for them, or added.
    const known = snapshot.seconds.flatMap((s) => seconds.get(s.t) ?? [])
    const into = mergeSnapshots(
      { ...emptySnapshot(), seconds: known },
      { ...emptySnapshot(), seconds: snapshot.seconds },
    )
    for (const s of into.seconds) seconds.set(s.t, s)
    const reported = snapshot.seconds.at(-1)
    if (reported) slot.through = Math.max(slot.through, reported.t + 1)
    if (last) {
      slot.done = true
      slot.through = Infinity
    }
    if (slots.every((s) => s.done)) return finish(state === 'stopping' ? 'stopped' : 'completed')
    const complete = Math.min(...slots.map((s) => s.through))
    if (complete > ticked) {
      const ticks = ticksBetween(ticked, complete)
      ticked = complete
      deps.emit({ testId, type: 'tick', ticks, totals: totals(deps.now() - t0) })
    }
  }

  const fail = (message: string) => finish('error', message)

  const spawned: WorkerLike[] = []
  try {
    for (let w = 0; w < count; w++) {
      const vus: number[] = []
      for (let k = w; k < options.vus; k += count) vus.push(k)
      spawned.push(
        deps.spawnWorker({
          requests,
          vus,
          totalVus: options.vus,
          durationMs: options.durationSec * 1000,
          rampUpMs: options.rampUpSec * 1000,
          thinkTimeMs: options.thinkTimeMs,
          timeoutMs: options.timeoutSec * 1000,
        }),
      )
    }
  } catch (e) {
    for (const worker of spawned) void worker.terminate().catch(() => 0)
    throw e
  }
  for (const worker of spawned) {
    const slot: Slot = { worker, latest: emptySnapshot(), through: 0, done: false }
    slots.push(slot)
    worker.on('message', (msg: FromLoadWorker) => {
      if (state === 'finished' || slot.done) return
      onSnapshot(slot, msg.snapshot, msg.type === 'done')
    })
    worker.on('error', (e: Error) => {
      if (state !== 'finished') fail(`A load worker failed: ${e instanceof Error ? e.message : String(e)}`)
    })
    worker.on('exit', (code: number) => {
      if (state !== 'finished' && !slot.done) fail(`A load worker stopped unexpectedly (exit code ${code})`)
    })
  }

  const watchdog = setTimeout(
    () => fail('A load worker stopped responding'),
    options.durationSec * 1000 + 2000 + WATCHDOG_SLACK_MS,
  )

  deps.emit({
    testId,
    type: 'started',
    startedAt: startedAt.toISOString(),
    requests: resolved.requests.map((r, i) => ({ name: r.name, method: r.method, url: resolved.displayUrls[i] ?? '' })),
    workers: count,
  })

  return {
    testId,
    done,
    stop() {
      if (state !== 'running') return
      state = 'stopping'
      for (const slot of slots) {
        if (slot.done) continue
        try {
          slot.worker.postMessage({ type: 'stop' })
        } catch {
          // A worker that is gone is terminated below.
        }
      }
      stopTimer = setTimeout(() => finish('stopped'), STOP_GRACE_MS)
    },
  }
}
