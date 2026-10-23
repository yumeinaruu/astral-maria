import type { RunResult, StopReason } from '../../../shared/types'

/** The exported report of a collection run. */
export interface RunReport {
  collection: string
  folder?: string
  environment: string | null
  startedAt: string
  durationMs: number
  reason: StopReason
  iterations: number
  delayMs: number
  dataFile: string | null
  totals: {
    requests: number
    failedRequests: number
    tests: { passed: number; failed: number; skipped: number }
    avgTimeMs: number
  }
  results: RunResult[]
}

/** What the report says about the run besides its results. */
export interface RunMeta {
  collection: string
  /** Set for a folder run. */
  folder?: string
  environment: string | null
  startedAt: string
  iterations: number
  delayMs: number
  dataFile: string | null
}

/**
 * A request execution failed when it has an error (send, load or pre-request script), a script that failed, or a
 * failed test. A 4xx or 5xx status alone is a response, not a failure.
 */
export function isFailedResult(result: RunResult): boolean {
  return (
    result.error !== undefined || result.failures.length > 0 || result.tests.some((t) => !t.skipped && !t.passed)
  )
}

export function testCounts(results: RunResult[]): { passed: number; failed: number; skipped: number } {
  const counts = { passed: 0, failed: 0, skipped: 0 }
  for (const r of results) {
    for (const t of r.tests) {
      if (t.skipped) counts.skipped++
      else if (t.passed) counts.passed++
      else counts.failed++
    }
  }
  return counts
}

/** The mean time of the executions that got a response, rounded to whole ms; 0 when none did. */
export function averageTime(results: RunResult[]): number {
  const times = results.map((r) => r.timeMs).filter((t): t is number => t !== undefined)
  return times.length === 0 ? 0 : Math.round(times.reduce((a, b) => a + b, 0) / times.length)
}

export function buildReport(
  meta: RunMeta,
  results: RunResult[],
  finished: { reason: StopReason; durationMs: number },
): RunReport {
  return {
    collection: meta.collection,
    ...(meta.folder !== undefined ? { folder: meta.folder } : {}),
    environment: meta.environment,
    startedAt: meta.startedAt,
    durationMs: finished.durationMs,
    reason: finished.reason,
    iterations: meta.iterations,
    delayMs: meta.delayMs,
    dataFile: meta.dataFile,
    totals: {
      requests: results.length,
      failedRequests: results.filter(isFailedResult).length,
      tests: testCounts(results),
      avgTimeMs: averageTime(results),
    },
    results,
  }
}

const ILLEGAL = /[/\\:*?"<>|\u0000-\u001f]/g

/**
 * `<name>-<kind>-<yyyy-mm-dd-hhmmss>.json`, the time in UTC; characters illegal in file names become `_`, and an empty
 * name becomes `kind`.
 */
export function stampedFileName(name: string, kind: string, startedAt: string): string {
  const safe = name.trim().replace(ILLEGAL, '_') || kind
  const d = new Date(startedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = Number.isNaN(d.getTime())
    ? 'unknown'
    : `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-` +
      `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  return `${safe}-${kind}-${stamp}.json`
}

/** `<name>-run-<yyyy-mm-dd-hhmmss>.json` (see `stampedFileName`). */
export function reportFileName(name: string, startedAt: string): string {
  return stampedFileName(name, 'run', startedAt)
}
