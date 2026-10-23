import { parentPort, workerData } from 'node:worker_threads'
import { Agent } from 'undici'
import type { DispatchSpec } from '../http/dispatchOptions'
import { Metrics, type MetricsSnapshot } from './metrics'

// The worker_threads entry of a load test: drives its share of the virtual users with its own undici Agent (one
// keep-alive connection per VU) and posts a metrics snapshot every second, then a final one when it is done. Every
// time below is on this worker's performance.now() clock.

export interface WorkerInit {
  /** The resolved requests, as undici dispatches them; a VU walks them round-robin. */
  requests: DispatchSpec[]
  /** The global (0-based) indices of this worker's VUs. */
  vus: number[]
  /** VUs across every worker; VU `k` starts at `rampUpMs * k / totalVus`. */
  totalVus: number
  durationMs: number
  rampUpMs: number
  thinkTimeMs: number
  timeoutMs: number
}

export type ToLoadWorker = { type: 'stop' }

/** `snapshot` every second; `done` (with the final snapshot) last, once every VU has ended. */
export type FromLoadWorker =
  | { type: 'snapshot'; snapshot: MetricsSnapshot }
  | { type: 'done'; snapshot: MetricsSnapshot }

/** How long requests in flight at the end of the duration may take to finish before they are aborted. */
const GRACE_MS = 2000
/** The least pause after a transport failure, so an unreachable target is not hit in a hot loop. */
const FAILURE_BACKOFF_MS = 50
const SNAPSHOT_MS = 1000
/** Snapshots are taken just after a second ends, so a late timer never leaves that second open. */
const SNAPSHOT_SLACK_MS = 5

const TLS_CODE = /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH|EPROTO)/

/** The code a transport failure is counted under: its system or undici code, `tls` for TLS failures. */
export function failureCode(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown }; errors?: { code?: unknown }[] }
  const raw = e?.code ?? e?.cause?.code ?? e?.errors?.[0]?.code
  const code = typeof raw === 'string' ? raw : ''
  if (TLS_CODE.test(code)) return 'tls'
  return code === '' ? 'network_error' : code
}

/** Resolves after `ms`, or as soon as `signal` is aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve()
    const end = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', end)
      resolve()
    }
    const timer = setTimeout(end, ms)
    signal.addEventListener('abort', end, { once: true })
  })
}

/** A structured clone turns a Buffer body into a plain Uint8Array; undici takes either. */
function asSpec(spec: DispatchSpec): DispatchSpec {
  const body = spec.body as Buffer | Uint8Array | string | undefined
  if (body instanceof Uint8Array && !Buffer.isBuffer(body)) {
    return { ...spec, body: Buffer.from(body.buffer, body.byteOffset, body.byteLength) }
  }
  return spec
}

interface InFlight {
  controller: AbortController
  why: 'timeout' | 'aborted' | null
}

function runLoad(init: WorkerInit, post: (msg: FromLoadWorker) => void): { stop(): void } {
  const t0 = performance.now()
  const metrics = new Metrics(t0)
  const requests = init.requests.map(asSpec)
  const agent = new Agent({
    connections: Math.max(1, init.vus.length),
    headersTimeout: 0,
    bodyTimeout: 0,
    // The request timeout below is the only deadline, so a slow connect is counted as `timeout` too.
    connect: { timeout: 0 },
  })
  /** Aborted at the end of the duration (or on stop): no new requests start, pauses end. */
  const ending = new AbortController()
  const inFlight = new Set<InFlight>()
  let active = 0
  let finished = false

  const abortInFlight = () => {
    for (const f of inFlight) {
      f.why ??= 'aborted'
      f.controller.abort()
    }
  }
  const end = (hard: boolean) => {
    if (!ending.signal.aborted) ending.abort()
    clearTimeout(endTimer)
    if (hard) abortInFlight()
    else graceTimer ??= setTimeout(abortInFlight, GRACE_MS)
  }
  const endTimer = setTimeout(() => end(false), init.durationMs)
  let graceTimer: NodeJS.Timeout | undefined

  let snapshotTimer: NodeJS.Timeout | undefined
  const scheduleSnapshot = (n: number) => {
    const at = t0 + n * SNAPSHOT_MS + SNAPSHOT_SLACK_MS
    snapshotTimer = setTimeout(
      () => {
        if (finished) return
        post({ type: 'snapshot', snapshot: metrics.drain(performance.now()) })
        scheduleSnapshot(n + 1)
      },
      Math.max(0, at - performance.now()),
    )
  }
  scheduleSnapshot(1)

  /** Sends one request; true when it failed at transport level. */
  async function once(spec: DispatchSpec): Promise<boolean> {
    const flight: InFlight = { controller: new AbortController(), why: null }
    inFlight.add(flight)
    const timer = setTimeout(() => {
      flight.why ??= 'timeout'
      flight.controller.abort()
    }, init.timeoutMs)
    const started = performance.now()
    try {
      // reset: false keeps the connection for HEAD and for requests with a body (a GET with a JSON body, say),
      // which undici would otherwise close after each response: a load test would open one socket per request and
      // run out of local ports (EADDRNOTAVAIL).
      const res = await agent.request({ ...spec, signal: flight.controller.signal, reset: false })
      let bytes = 0
      for await (const chunk of res.body) bytes += (chunk as Buffer).length
      const at = performance.now()
      metrics.recordResponse(res.statusCode, at - started, bytes, at)
      return false
    } catch (err) {
      if (flight.why === 'aborted') {
        metrics.recordAborted()
        return false
      }
      metrics.recordFailure(flight.why === 'timeout' ? 'timeout' : failureCode(err), performance.now())
      return true
    } finally {
      clearTimeout(timer)
      inFlight.delete(flight)
    }
  }

  async function vu(k: number): Promise<void> {
    // Timers may fire a fraction of a millisecond early; a VU must not start in the second before its own.
    const startAt = t0 + (init.rampUpMs * k) / init.totalVus
    while (!ending.signal.aborted && performance.now() < startAt) {
      await sleep(Math.max(1, startAt - performance.now()), ending.signal)
    }
    if (ending.signal.aborted) return
    metrics.setActiveVus(++active, performance.now())
    let i = k % requests.length
    try {
      while (!ending.signal.aborted) {
        const failed = await once(requests[i])
        i = (i + 1) % requests.length
        const pause = failed ? Math.max(init.thinkTimeMs, FAILURE_BACKOFF_MS) : init.thinkTimeMs
        if (pause > 0) await sleep(pause, ending.signal)
      }
    } finally {
      metrics.setActiveVus(--active, performance.now())
    }
  }

  void Promise.all(init.vus.map((k) => vu(k).catch(() => undefined))).then(async () => {
    finished = true
    clearTimeout(endTimer)
    clearTimeout(graceTimer)
    clearTimeout(snapshotTimer)
    post({ type: 'done', snapshot: metrics.drain(performance.now(), true) })
    await agent.destroy().catch(() => undefined)
  })

  return { stop: () => end(true) }
}

const port = parentPort
if (!port) throw new Error('The load worker must run in a worker thread')
const run = runLoad(workerData as WorkerInit, (msg) => {
  port.postMessage(msg)
  // Nothing follows `done`: the worker exits once its agent is closed.
  if (msg.type === 'done') port.unref()
})
port.on('message', (msg: ToLoadWorker) => {
  if (msg.type === 'stop') run.stop()
})
