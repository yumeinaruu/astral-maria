import { describe, expect, it } from 'vitest'
import {
  buildLoadReport,
  formatMs,
  formatPercent,
  isLocalHost,
  loadReportFileName,
  type LoadMeta,
} from '../../src/renderer/src/lib/loadReport'
import type { LoadOptions, LoadTick, LoadTotals } from '../../src/shared/types'

const OPTIONS: LoadOptions = {
  path: 'collections/shop/health.request.json',
  environmentId: 'env-1',
  vus: 5,
  durationSec: 3,
  rampUpSec: 0,
  thinkTimeMs: 0,
  timeoutSec: 30,
}

const TOTALS: LoadTotals = {
  completed: 120,
  errors: 2,
  aborted: 0,
  bytes: 4800,
  rps: 40,
  p50: 3.2,
  p95: 8.4,
  p99: 12.1,
  mean: 3.9,
  max: 20,
  errorRate: 2 / 120,
  status: { '200': 118, '500': 2 },
  errorCodes: { '5xx': 2 },
}

const TICKS: LoadTick[] = [
  { t: 0, rps: 40, errors: 1, activeVus: 5, p50: 3, p95: 8, p99: 12 },
  { t: 1, rps: 41, errors: 1, activeVus: 5, p50: 3.3, p95: 8.5, p99: 12.2 },
]

const META: LoadMeta = {
  target: {
    name: 'Health',
    path: OPTIONS.path,
    requests: [{ name: 'Health', method: 'GET', url: 'http://127.0.0.1:3000/health?key=••••' }],
  },
  environment: 'Dev',
  startedAt: '2026-10-23T08:04:05.000Z',
}

describe('buildLoadReport', () => {
  it('has the target, environment, options, start, duration, reason, totals and ticks', () => {
    const report = buildLoadReport(META, {
      options: OPTIONS,
      totals: TOTALS,
      ticks: TICKS,
      finished: { reason: 'completed', durationMs: 3012 },
    })
    expect(report).toEqual({
      target: META.target,
      environment: 'Dev',
      options: OPTIONS,
      startedAt: '2026-10-23T08:04:05.000Z',
      durationMs: 3012,
      reason: 'completed',
      totals: TOTALS,
      ticks: TICKS,
    })
    expect(Object.keys(report)).toEqual([
      'target',
      'environment',
      'options',
      'startedAt',
      'durationMs',
      'reason',
      'totals',
      'ticks',
    ])
  })

  it('adds the message of a test that ended in an error', () => {
    const report = buildLoadReport(META, {
      options: OPTIONS,
      totals: TOTALS,
      ticks: [],
      finished: { reason: 'error', message: 'worker crashed', durationMs: 5 },
    })
    expect(report).toMatchObject({ reason: 'error', message: 'worker crashed' })
  })
})

describe('loadReportFileName', () => {
  it('is <name>-load-<yyyy-mm-dd-hhmmss>.json in UTC', () => {
    expect(loadReportFileName('Health', '2026-10-23T08:04:05.000Z')).toBe('Health-load-2026-10-23-080405.json')
    expect(loadReportFileName('Health', '2026-10-23T23:59:59.000+02:00')).toBe('Health-load-2026-10-23-215959.json')
  })

  it('replaces characters that are illegal in file names', () => {
    expect(loadReportFileName('a/b:c', '2026-10-23T08:04:05.000Z')).toBe('a_b_c-load-2026-10-23-080405.json')
  })
})

describe('isLocalHost', () => {
  it.each(['127.0.0.1', '127.8.0.1', 'localhost', 'api.localhost', '::1', '10.0.0.4', '172.16.0.1', '172.31.255.1'])(
    'counts %s as loopback or private',
    (host) => expect(isLocalHost(host)).toBe(true),
  )
  it.each(['192.168.1.5', '169.254.10.1', 'fd12::1', 'fe80::1', '0.0.0.0'])('counts %s as private', (host) =>
    expect(isLocalHost(host)).toBe(true),
  )
  it.each(['api.example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2001:db8::1', '11.0.0.1'])(
    'counts %s as public',
    (host) => expect(isLocalHost(host)).toBe(false),
  )
})

describe('formatting', () => {
  it('formats latencies in ms', () => {
    expect(formatMs(3.24)).toBe('3.2')
    expect(formatMs(12.6)).toBe('13')
    expect(formatMs(1234)).toBe('1 234')
  })

  it('formats a 0..1 fraction as a percentage', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(2 / 120)).toBe('1.7%')
    expect(formatPercent(1)).toBe('100%')
  })
})
