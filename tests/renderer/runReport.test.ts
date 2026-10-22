import { describe, expect, it } from 'vitest'
import { buildReport, isFailedResult, reportFileName } from '../../src/renderer/src/lib/runReport'
import type { RunResult } from '../../src/shared/types'

function result(patch: Partial<RunResult> = {}): RunResult {
  return {
    iteration: 0,
    path: 'collections/shop/a.request.json',
    name: 'A',
    method: 'GET',
    url: 'http://x/a',
    status: 200,
    statusText: 'OK',
    timeMs: 100,
    sizeBytes: 10,
    tests: [],
    failures: [],
    ...patch,
  }
}

const META = {
  collection: 'Shop',
  environment: 'Local',
  startedAt: '2026-10-22T09:05:07.123Z',
  iterations: 2,
  delayMs: 0,
  dataFile: null,
}

describe('buildReport', () => {
  it('totals the requests, failed requests and tests, and averages the times', () => {
    const results = [
      result({
        tests: [
          { name: 'a', passed: true, skipped: false, source: 'Request' },
          { name: 'b', passed: false, skipped: false, error: 'nope', source: 'Request' },
        ],
      }),
      result({ timeMs: 301, tests: [{ name: 'c', passed: false, skipped: true, source: 'Request' }] }),
      // An error without a response: no time, so it does not count in the average.
      result({ status: undefined, timeMs: undefined, sizeBytes: undefined, error: 'ECONNREFUSED' }),
      result({ timeMs: 50, failures: [{ phase: 'post-response', source: 'Request', message: 'boom' }] }),
    ]
    const report = buildReport(META, results, { reason: 'completed', durationMs: 1234 })
    expect(report.totals).toEqual({
      requests: 4,
      failedRequests: 3,
      tests: { passed: 1, failed: 1, skipped: 1 },
      avgTimeMs: 150,
    })
    expect(report).toMatchObject({
      collection: 'Shop',
      environment: 'Local',
      startedAt: META.startedAt,
      durationMs: 1234,
      reason: 'completed',
      iterations: 2,
      delayMs: 0,
      dataFile: null,
      results,
    })
    expect('folder' in report).toBe(false)
  })

  it('keeps the folder and gives an average of 0 when nothing got a response', () => {
    const report = buildReport({ ...META, folder: 'Users' }, [result({ timeMs: undefined, error: 'x' })], {
      reason: 'stopped',
      durationMs: 5,
    })
    expect(report.folder).toBe('Users')
    expect(report.totals.avgTimeMs).toBe(0)
    expect(report.reason).toBe('stopped')
  })

  it('counts a request as failed on an error, a script failure or a failed test, not on a 4xx', () => {
    expect(isFailedResult(result({ status: 404 }))).toBe(false)
    expect(isFailedResult(result({ error: 'x' }))).toBe(true)
    expect(isFailedResult(result({ failures: [{ phase: 'pre-request', source: 's', message: 'm' }] }))).toBe(true)
    expect(isFailedResult(result({ tests: [{ name: 't', passed: false, skipped: false, source: 's' }] }))).toBe(true)
    expect(isFailedResult(result({ tests: [{ name: 't', passed: false, skipped: true, source: 's' }] }))).toBe(false)
  })
})

describe('reportFileName', () => {
  it('is <name>-run-<yyyy-mm-dd-hhmmss>.json (UTC)', () => {
    expect(reportFileName('Shop', '2026-10-22T09:05:07.123Z')).toBe('Shop-run-2026-10-22-090507.json')
  })

  it('replaces characters that are illegal in file names', () => {
    expect(reportFileName('a/b\\c:d*e?f"g<h>i|j', '2026-01-02T03:04:05Z')).toBe(
      'a_b_c_d_e_f_g_h_i_j-run-2026-01-02-030405.json',
    )
  })

  it('falls back to "run" for an empty name', () => {
    expect(reportFileName('  ', '2026-01-02T03:04:05Z')).toBe('run-run-2026-01-02-030405.json')
  })
})
