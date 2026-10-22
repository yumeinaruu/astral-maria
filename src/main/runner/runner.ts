import { randomUUID } from 'node:crypto'
import type { HttpMethod, RunEvent, RunOptions, RunResult, SendResult, StopReason } from '../../shared/types'
import { MAX_DATA_ROWS, type DataRow } from './dataFile'

// The collection runner's loop: iterations over the selected requests, honouring `postman.setNextRequest`, with a
// delay between requests. The per-request send (scripts, variables, persistence, masking) and the events' transport
// are injected by api.ts, so this module touches no store and no IPC itself.

export const MAX_ITERATIONS = 10_000
export const MAX_DELAY_MS = 600_000
/** Request executions in one iteration; a guard against `setNextRequest` loops. */
export const MAX_ITERATION_EXECUTIONS = 10_000

/**
 * In-memory variable layer for keepVariables === false; sendOne reads it on top of disk and writes changes into it
 * instead of persisting.
 */
export interface VariableOverlay {
  environment: Map<string, string | null>
  globals: Map<string, string | null>
  collection: Map<string, string | null>
}

/** A request of the collection or folder being run; `loadError` when its file could not be read. */
export interface PlanEntry {
  path: string
  name: string
  method: HttpMethod
  loadError?: string
}

export interface SendOneInput {
  requestPath: string
  environmentId: string | null
  data: Record<string, unknown>
  info: { iteration: number; iterationCount: number }
  overlay: VariableOverlay | null
  signal: AbortSignal
}

export interface RunnerDeps {
  /** `url`: the URL sent (or about to be), secrets masked; the response's final URL is used when it is absent. */
  sendOne(input: SendOneInput): Promise<SendResult & { url?: string }>
  /** The requests under a collection or folder path, in tree order; rejects when the path is not found. */
  loadPlan(path: string): Promise<PlanEntry[]>
  emit(event: RunEvent): void
  /** Resolves after `ms`, or early once `signal` is aborted. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

export interface RunHandle {
  runId: string
  /** Resolves once `started` is emitted; rejects, emitting nothing, if the plan fails to load or on an early stop. */
  started: Promise<void>
  /** Resolves when the loop has ended; never rejects. */
  done: Promise<void>
  /** Aborts the request or delay in flight and emits `finished` with `stopped` at once; then nothing more. */
  stop(): void
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const intIn = (v: unknown, min: number, max: number) =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max

/** Throws `invalid_run_options: <field>` for the first field that is not valid. */
export function validateRunOptions(o: RunOptions): void {
  const bad = (field: string): never => {
    throw new Error(`invalid_run_options: ${field}`)
  }
  if (!isRecord(o)) bad('options')
  if (typeof o.path !== 'string' || o.path === '') bad('path')
  if (
    !Array.isArray(o.requestPaths) ||
    o.requestPaths.length === 0 ||
    !o.requestPaths.every((p) => typeof p === 'string' && p.startsWith(`${o.path}/`))
  ) {
    bad('requestPaths')
  }
  if (o.environmentId !== null && typeof o.environmentId !== 'string') bad('environmentId')
  if (!intIn(o.iterations, 1, MAX_ITERATIONS)) bad('iterations')
  if (!intIn(o.delayMs, 0, MAX_DELAY_MS)) bad('delayMs')
  if (
    o.data !== null &&
    (!isRecord(o.data) ||
      typeof o.data.name !== 'string' ||
      !Array.isArray(o.data.rows) ||
      o.data.rows.length === 0 ||
      o.data.rows.length > MAX_DATA_ROWS ||
      !o.data.rows.every(isRecord))
  ) {
    bad('data')
  }
  if (typeof o.keepVariables !== 'boolean') bad('keepVariables')
  if (typeof o.stopOnError !== 'boolean') bad('stopOnError')
}

/** Resolves after `ms`, or as soon as `signal` is aborted. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const end = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', end)
      resolve()
    }
    const timer = setTimeout(end, ms)
    signal.addEventListener('abort', end, { once: true })
  })
}

/** `collections/c/get-users.request.json` -> `get-users`: the name shown for a request that could not be read. */
export function fileName(p: string): string {
  return (p.split('/').at(-1) ?? p).replace(/\.request\.json$/, '')
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function toResult(entry: PlanEntry, iteration: number, sent: SendResult & { url?: string }): RunResult {
  const scripts = sent.scripts
  const result: RunResult = {
    iteration,
    path: entry.path,
    name: entry.name,
    method: entry.method,
    url: sent.url ?? (sent.ok ? sent.response.finalUrl : ''),
    tests: scripts?.tests ?? [],
    failures: scripts?.failures ?? [],
  }
  if (sent.ok) {
    result.status = sent.response.status
    result.statusText = sent.response.statusText
    result.timeMs = sent.response.totalMs
    result.sizeBytes = sent.response.sizeBytes
  } else {
    result.error = sent.error.message
  }
  return result
}

const failed = (r: RunResult) => r.error !== undefined || r.tests.some((t) => !t.passed && !t.skipped)

/**
 * Starts a run; throws `invalid_run_options: <field>` before starting anything.
 *
 * - Iteration `i` uses data row `i % rows.length` (or `{}`), and walks the selected requests in the order given.
 * - After each request its report's `nextRequest` decides what comes next: absent, the next one; null, stop the run
 *   (`completed`); a name, the first selected request with that name, or stop with `next_request_not_found`.
 * - `delayMs` is slept between two consecutive requests, also across iterations, but not after the last one.
 * - A request whose file failed to load gives a failed result without a send, and the run carries on.
 * - `stopOnError` stops (`error`) after the first result with an error or a failed test.
 * - More than MAX_ITERATION_EXECUTIONS executions in one iteration stop the run with `loop_guard`.
 * - `finished` is the last event; a request stopped mid-way gives no result.
 */
export function startRun(deps: RunnerDeps, options: RunOptions): RunHandle {
  validateRunOptions(options)
  const runId = randomUUID()
  const controller = new AbortController()
  const { signal } = controller
  const started = Date.now()
  let isStarted = false
  let isFinished = false

  const finish = (reason: StopReason) => {
    if (isFinished) return
    isFinished = true
    if (isStarted) deps.emit({ runId, type: 'finished', reason, durationMs: Date.now() - started })
  }

  let resolveStarted!: () => void
  let rejectStarted!: (e: Error) => void
  const startedPromise = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
  })
  // Callers that only await `done` must not see an unhandled rejection.
  startedPromise.catch(() => undefined)

  async function loop(): Promise<void> {
    let plan: PlanEntry[]
    try {
      plan = await deps.loadPlan(options.path)
    } catch (e) {
      isFinished = true
      rejectStarted(new Error(message(e)))
      return
    }
    if (signal.aborted) {
      rejectStarted(new Error('run_stopped'))
      return
    }
    const byPath = new Map(plan.map((e) => [e.path, e]))
    const items: PlanEntry[] = [...new Set(options.requestPaths)].map(
      (p) => byPath.get(p) ?? { path: p, name: fileName(p), method: 'GET', loadError: 'Request not found' },
    )
    const overlay: VariableOverlay | null = options.keepVariables
      ? null
      : { environment: new Map(), globals: new Map(), collection: new Map() }

    isStarted = true
    deps.emit({
      runId,
      type: 'started',
      total: items.length * options.iterations,
      startedAt: new Date(started).toISOString(),
    })
    resolveStarted()

    let first = true
    for (let iteration = 0; iteration < options.iterations; iteration++) {
      const rows = options.data?.rows
      const data: DataRow = rows ? rows[iteration % rows.length] : {}
      let index = 0
      let executions = 0
      while (index < items.length) {
        if (executions === MAX_ITERATION_EXECUTIONS) return finish('loop_guard')
        if (!first && options.delayMs > 0) await deps.sleep(options.delayMs, signal)
        if (signal.aborted) return
        first = false
        executions++
        const item = items[index]
        let result: RunResult
        let next: string | null | undefined
        if (item.loadError !== undefined) {
          result = {
            iteration,
            path: item.path,
            name: item.name,
            method: item.method,
            url: '',
            tests: [],
            failures: [],
            error: item.loadError,
          }
        } else {
          let sent: SendResult & { url?: string }
          try {
            sent = await deps.sendOne({
              requestPath: item.path,
              environmentId: options.environmentId,
              data,
              info: { iteration, iterationCount: options.iterations },
              overlay,
              signal,
            })
          } catch (e) {
            sent = { ok: false, error: { code: 'send_failed', message: message(e) } }
          }
          if (signal.aborted) return
          result = toResult(item, iteration, sent)
          next = sent.scripts?.nextRequest
        }
        deps.emit({ runId, type: 'result', result })
        if (options.stopOnError && failed(result)) return finish('error')
        if (next === null) return finish('completed')
        if (next === undefined) {
          index++
          continue
        }
        const target = items.findIndex((i) => i.name === next)
        if (target < 0) return finish(`next_request_not_found: "${next}"`)
        index = target
      }
    }
    finish('completed')
  }

  const done = loop().catch((e: unknown) => {
    rejectStarted(new Error(message(e)))
    finish('error')
  })

  return {
    runId,
    started: startedPromise,
    done,
    stop() {
      if (isFinished) return
      controller.abort()
      finish('stopped')
    },
  }
}
