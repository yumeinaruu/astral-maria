/**
 * Load test counters. A worker records into a `Metrics` and drains a `MetricsSnapshot` every second; the main process
 * merges the workers' snapshots with `mergeSnapshots`. Snapshots are plain data, so they cross `postMessage`.
 *
 * Error rate = (4xx + 5xx + transport failures) / completed. Aborted requests are neither completed nor in the
 * latency stats; transport failures are completed but have no latency.
 */

import { Histogram, type HistogramData } from './histogram'

/** One whole second of the run; `t` is whole seconds since the start. */
export interface SecondBucket {
  t: number
  completed: number
  errors: number
  latency: HistogramData
  activeVus: number
}

export interface MetricsSnapshot {
  /** Cumulative since the start of the run. */
  total: { completed: number; errors: number; aborted: number; bytes: number; latency: HistogramData }
  /** Cumulative count per response status code ("200", "404", …). */
  status: Record<string, number>
  /** Cumulative count per error ("ECONNREFUSED", "timeout", "4xx", "5xx", …). */
  errors: Record<string, number>
  /** Seconds closed since the previous snapshot, ordered by `t`. */
  seconds: SecondBucket[]
}

interface OpenSecond {
  completed: number
  errors: number
  latency: Histogram
  /** The last value set during this second; quiet seconds carry the previous second's value. */
  activeVus?: number
}

const bump = (map: Record<string, number>, key: string, by = 1): void => {
  map[key] = (map[key] ?? 0) + by
}

export class Metrics {
  private completed = 0
  private errorCount = 0
  private aborted = 0
  private bytes = 0
  private readonly latency = new Histogram()
  private readonly status: Record<string, number> = {}
  private readonly errors: Record<string, number> = {}
  private readonly open = new Map<number, OpenSecond>()
  /** The first second not yet drained. */
  private nextT = 0
  private lastVus = 0

  /** `startedAt` and every `at`/`now` below are on the same ms clock (e.g. `performance.now()`). */
  constructor(private readonly startedAt: number) {}

  /** A response arrived (any status). 4xx and 5xx count as errors. */
  recordResponse(status: number, ms: number, bytes: number, at: number): void {
    const error = status >= 400 && status < 600
    this.completed++
    this.bytes += bytes
    this.latency.record(ms)
    bump(this.status, String(status))
    if (error) {
      this.errorCount++
      bump(this.errors, status < 500 ? '4xx' : '5xx')
    }
    const s = this.second(at)
    s.completed++
    if (error) s.errors++
    s.latency.record(ms)
  }

  /** A transport failure (`ECONNREFUSED`, `timeout`, `tls`, …): completed and an error, with no latency. */
  recordFailure(code: string, at: number): void {
    this.completed++
    this.errorCount++
    bump(this.errors, code)
    const s = this.second(at)
    s.completed++
    s.errors++
  }

  /** A request cut off at the end of the run: neither completed nor in the latency stats. */
  recordAborted(): void {
    this.aborted++
  }

  setActiveVus(n: number, at: number): void {
    this.second(at).activeVus = n
  }

  /**
   * Returns and clears what accumulated since the last call; the totals keep growing. Closes every second that ended
   * by `now`, gaps included; with `final`, the second in progress is closed too.
   */
  drain(now: number, final = false): MetricsSnapshot {
    const current = this.secondOf(now)
    const end = final ? current + 1 : current
    const seconds: SecondBucket[] = []
    for (; this.nextT < end; this.nextT++) {
      const s = this.open.get(this.nextT)
      this.open.delete(this.nextT)
      if (s?.activeVus !== undefined) this.lastVus = s.activeVus
      seconds.push({
        t: this.nextT,
        completed: s?.completed ?? 0,
        errors: s?.errors ?? 0,
        latency: (s?.latency ?? new Histogram()).toData(),
        activeVus: this.lastVus,
      })
    }
    return {
      total: {
        completed: this.completed,
        errors: this.errorCount,
        aborted: this.aborted,
        bytes: this.bytes,
        latency: this.latency.toData(),
      },
      status: { ...this.status },
      errors: { ...this.errors },
      seconds,
    }
  }

  private secondOf(at: number): number {
    return Math.max(0, Math.floor((at - this.startedAt) / 1000))
  }

  /** The open second for `at`; an event stamped in an already drained second goes to the earliest open one. */
  private second(at: number): OpenSecond {
    const t = Math.max(this.secondOf(at), this.nextT)
    let s = this.open.get(t)
    if (!s) {
      s = { completed: 0, errors: 0, latency: new Histogram() }
      this.open.set(t, s)
    }
    return s
  }
}

export function emptySnapshot(): MetricsSnapshot {
  return {
    total: { completed: 0, errors: 0, aborted: 0, bytes: 0, latency: new Histogram().toData() },
    status: {},
    errors: {},
    seconds: [],
  }
}

const mergeHistograms = (a: HistogramData, b: HistogramData): HistogramData => {
  const h = Histogram.from(a)
  h.merge(b)
  return h.toData()
}

/**
 * Adds `from` into `into` and returns `into`; `from` is not changed or aliased. Seconds that share the same `t` are
 * merged (their `activeVus` summed, as each worker reports its own VUs). Totals are summed, so merge each worker's
 * latest snapshot once rather than successive snapshots of the same worker.
 */
export function mergeSnapshots(into: MetricsSnapshot, from: MetricsSnapshot): MetricsSnapshot {
  const t = into.total
  t.completed += from.total.completed
  t.errors += from.total.errors
  t.aborted += from.total.aborted
  t.bytes += from.total.bytes
  t.latency = mergeHistograms(t.latency, from.total.latency)
  for (const [k, n] of Object.entries(from.status)) bump(into.status, k, n)
  for (const [k, n] of Object.entries(from.errors)) bump(into.errors, k, n)

  const byT = new Map(into.seconds.map((s) => [s.t, s]))
  for (const s of from.seconds) {
    const mine = byT.get(s.t)
    if (mine) {
      mine.completed += s.completed
      mine.errors += s.errors
      mine.activeVus += s.activeVus
      mine.latency = mergeHistograms(mine.latency, s.latency)
    } else {
      const copy = { ...s, latency: Histogram.from(s.latency).toData() }
      byT.set(s.t, copy)
      into.seconds.push(copy)
    }
  }
  into.seconds.sort((a, b) => a.t - b.t)
  return into
}

export function summary(
  s: MetricsSnapshot,
  durationMs: number,
): { rps: number; p50: number; p95: number; p99: number; mean: number; max: number; errorRate: number } {
  const h = Histogram.from(s.total.latency)
  const { completed, errors } = s.total
  return {
    rps: durationMs > 0 ? completed / (durationMs / 1000) : 0,
    p50: h.percentile(50),
    p95: h.percentile(95),
    p99: h.percentile(99),
    mean: h.mean,
    max: h.max,
    errorRate: completed > 0 ? errors / completed : 0,
  }
}
