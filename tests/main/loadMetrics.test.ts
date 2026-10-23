import { describe, expect, it } from 'vitest'
import { Histogram } from '../../src/main/load/histogram'
import { Metrics, emptySnapshot, mergeSnapshots, summary, type MetricsSnapshot } from '../../src/main/load/metrics'

const T0 = 10_000 // an arbitrary clock origin, as performance.now() would give

describe('Metrics.drain', () => {
  it('closes only whole seconds that have ended, and each second once', () => {
    const m = new Metrics(T0)
    m.recordResponse(200, 10, 100, T0 + 100)
    m.recordResponse(200, 20, 100, T0 + 900)
    m.recordResponse(200, 30, 100, T0 + 1500)

    const first = m.drain(T0 + 1200)
    expect(first.seconds.map((s) => s.t)).toEqual([0])
    expect(first.seconds[0].completed).toBe(2)
    expect(first.seconds[0].latency.count).toBe(2)
    expect(first.total.completed).toBe(3)

    expect(m.drain(T0 + 1900).seconds).toEqual([])

    const third = m.drain(T0 + 2000)
    expect(third.seconds.map((s) => s.t)).toEqual([1])
    expect(third.seconds[0].completed).toBe(1)
    expect(third.total.completed).toBe(3)
  })

  it('emits empty seconds for gaps so the series is contiguous', () => {
    const m = new Metrics(T0)
    m.recordResponse(200, 5, 0, T0 + 100)
    m.recordResponse(200, 5, 0, T0 + 3100)
    const s = m.drain(T0 + 4000)
    expect(s.seconds.map((b) => [b.t, b.completed])).toEqual([
      [0, 1],
      [1, 0],
      [2, 0],
      [3, 1],
    ])
    expect(s.seconds[1].latency).toEqual(new Histogram().toData())
  })

  it('final drain also closes the second in progress', () => {
    const m = new Metrics(T0)
    m.recordResponse(200, 5, 0, T0 + 1300)
    const s = m.drain(T0 + 1400, true)
    expect(s.seconds.map((b) => [b.t, b.completed])).toEqual([
      [0, 0],
      [1, 1],
    ])
    expect(m.drain(T0 + 1500, true).seconds).toEqual([])
  })

  it('reports activeVus per second: the last value set in that second, carried into quiet seconds', () => {
    const m = new Metrics(T0)
    m.setActiveVus(2, T0)
    m.setActiveVus(4, T0 + 500)
    m.recordResponse(200, 5, 0, T0 + 1200)
    m.setActiveVus(6, T0 + 2100)
    m.setActiveVus(0, T0 + 4500)
    const s = m.drain(T0 + 5000)
    expect(s.seconds.map((b) => [b.t, b.activeVus])).toEqual([
      [0, 4],
      [1, 4],
      [2, 6],
      [3, 6],
      [4, 0],
    ])
    m.recordResponse(200, 5, 0, T0 + 5100)
    expect(m.drain(T0 + 6000).seconds[0].activeVus).toBe(0)
  })

  it('counts 4xx, 5xx and transport failures as errors, and leaves aborted requests out', () => {
    const m = new Metrics(T0)
    m.recordResponse(200, 10, 50, T0 + 10)
    m.recordResponse(302, 10, 0, T0 + 20)
    m.recordResponse(404, 10, 5, T0 + 30)
    m.recordResponse(500, 10, 5, T0 + 40)
    m.recordResponse(503, 10, 5, T0 + 50)
    m.recordFailure('ECONNREFUSED', T0 + 60)
    m.recordFailure('timeout', T0 + 70)
    m.recordAborted()
    m.recordAborted()

    const s = m.drain(T0 + 1000)
    expect(s.total.completed).toBe(7)
    expect(s.total.errors).toBe(5)
    expect(s.total.aborted).toBe(2)
    expect(s.total.bytes).toBe(65)
    // Only responses have a latency; failures and aborted requests do not.
    expect(s.total.latency.count).toBe(5)
    expect(s.status).toEqual({ '200': 1, '302': 1, '404': 1, '500': 1, '503': 1 })
    expect(s.errors).toEqual({ '4xx': 1, '5xx': 2, ECONNREFUSED: 1, timeout: 1 })
    expect(s.seconds[0]).toMatchObject({ t: 0, completed: 7, errors: 5 })
    expect(s.seconds[0].latency.count).toBe(5)
    expect(summary(s, 1000).errorRate).toBeCloseTo(5 / 7, 10)
  })

  it('status and error maps accumulate across drains, like the totals', () => {
    const m = new Metrics(T0)
    m.recordResponse(200, 10, 1, T0 + 10)
    m.recordFailure('ECONNRESET', T0 + 20)
    const a = m.drain(T0 + 1000)
    m.recordResponse(200, 10, 1, T0 + 1010)
    m.recordResponse(404, 10, 1, T0 + 1020)
    m.recordFailure('ECONNRESET', T0 + 1030)
    const b = m.drain(T0 + 2000)
    expect(a.status).toEqual({ '200': 1 })
    expect(b.status).toEqual({ '200': 2, '404': 1 })
    expect(b.errors).toEqual({ ECONNRESET: 2, '4xx': 1 })
    expect(b.total.completed).toBe(5)
    expect(b.total.latency.count).toBe(3)
    expect(b.seconds.map((s) => s.t)).toEqual([1])
  })

  it('returns copies: later recording does not change an earlier snapshot', () => {
    const m = new Metrics(T0)
    m.recordResponse(200, 10, 1, T0 + 10)
    const a = m.drain(T0 + 1000)
    m.recordResponse(200, 10, 1, T0 + 1010)
    m.recordFailure('timeout', T0 + 1020)
    m.drain(T0 + 2000)
    expect(a.total.completed).toBe(1)
    expect(a.total.latency.count).toBe(1)
    expect(a.status).toEqual({ '200': 1 })
    expect(a.errors).toEqual({})
    expect(structuredClone(a)).toEqual(a)
  })

  it('folds an event stamped in an already closed second into the earliest open one', () => {
    const m = new Metrics(T0)
    m.drain(T0 + 2000)
    m.recordResponse(200, 10, 0, T0 + 500)
    m.recordResponse(200, 10, 0, T0 - 50)
    const s = m.drain(T0 + 3000)
    expect(s.seconds.map((b) => [b.t, b.completed])).toEqual([[2, 2]])
  })
})

function snapshotOf(build: (m: Metrics) => void, now: number): MetricsSnapshot {
  const m = new Metrics(T0)
  build(m)
  return m.drain(now)
}

describe('mergeSnapshots', () => {
  it('sums totals and maps, and merges seconds that share the same t', () => {
    const a = snapshotOf((m) => {
      m.setActiveVus(2, T0)
      m.recordResponse(200, 10, 10, T0 + 100)
      m.recordResponse(500, 30, 10, T0 + 1100)
      m.recordFailure('timeout', T0 + 1200)
    }, T0 + 2000)
    const b = snapshotOf((m) => {
      m.setActiveVus(3, T0)
      m.recordResponse(200, 20, 5, T0 + 1100)
      m.recordResponse(404, 40, 5, T0 + 2100)
      m.recordAborted()
    }, T0 + 3000)

    const merged = mergeSnapshots(mergeSnapshots(emptySnapshot(), a), b)
    expect(merged.total).toMatchObject({ completed: 5, errors: 3, aborted: 1, bytes: 30 })
    expect(merged.total.latency.count).toBe(4)
    expect(merged.status).toEqual({ '200': 2, '500': 1, '404': 1 })
    expect(merged.errors).toEqual({ '5xx': 1, timeout: 1, '4xx': 1 })
    expect(merged.seconds.map((s) => [s.t, s.completed, s.errors, s.activeVus, s.latency.count])).toEqual([
      [0, 1, 0, 5, 1],
      [1, 3, 2, 5, 2],
      [2, 1, 1, 3, 1],
    ])
    const one = Histogram.from(merged.seconds[1].latency)
    expect(one.min).toBe(20)
    expect(one.max).toBe(30)
  })

  it('returns `into`, and does not alias or change `from`', () => {
    const from = snapshotOf((m) => m.recordResponse(200, 10, 1, T0 + 10), T0 + 1000)
    const before = structuredClone(from)
    const into = emptySnapshot()
    const out = mergeSnapshots(into, from)
    expect(out).toBe(into)
    mergeSnapshots(into, from)
    expect(from).toEqual(before)
    expect(into.seconds[0].completed).toBe(2)
  })

  it('keeps seconds ordered by t when merging out of order', () => {
    const late = snapshotOf((m) => m.recordResponse(200, 1, 0, T0 + 3500), T0 + 4000)
    late.seconds = late.seconds.filter((s) => s.t === 3)
    const early = snapshotOf((m) => m.recordResponse(200, 1, 0, T0 + 500), T0 + 1000)
    const merged = mergeSnapshots(mergeSnapshots(emptySnapshot(), late), early)
    expect(merged.seconds.map((s) => s.t)).toEqual([0, 3])
  })
})

describe('summary', () => {
  it('derives rps, percentiles, mean, max and error rate', () => {
    const s = snapshotOf((m) => {
      for (let i = 1; i <= 100; i++) m.recordResponse(i <= 90 ? 200 : 500, i, 0, T0 + i)
      for (let i = 0; i < 25; i++) m.recordFailure('ECONNREFUSED', T0 + 200)
      m.recordAborted()
    }, T0 + 1000)
    const r = summary(s, 2500)
    expect(r.rps).toBeCloseTo(125 / 2.5, 10)
    expect(r.errorRate).toBeCloseTo(35 / 125, 10)
    expect(r.mean).toBeCloseTo(50.5, 10)
    expect(r.max).toBe(100)
    expect(Math.abs(r.p50 - 50) / 50).toBeLessThanOrEqual(0.01)
    expect(Math.abs(r.p95 - 95) / 95).toBeLessThanOrEqual(0.01)
    expect(Math.abs(r.p99 - 99) / 99).toBeLessThanOrEqual(0.01)
  })

  it('is all zeros for an empty snapshot or a zero duration', () => {
    expect(summary(emptySnapshot(), 0)).toEqual({ rps: 0, p50: 0, p95: 0, p99: 0, mean: 0, max: 0, errorRate: 0 })
    const s = snapshotOf((m) => m.recordResponse(200, 5, 0, T0), T0 + 1000)
    expect(summary(s, 0).rps).toBe(0)
  })
})
