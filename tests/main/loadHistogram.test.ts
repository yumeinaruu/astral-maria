import { describe, expect, it } from 'vitest'
import { Histogram } from '../../src/main/load/histogram'

// Deterministic PRNG (mulberry32), so the samples are the same on every run.
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normal(next: () => number): number {
  const u = 1 - next()
  const v = next()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const N = 100_000

const samples: Record<string, number[]> = {
  uniform: (() => {
    const next = rng(1)
    return Array.from({ length: N }, () => 0.5 + next() * 2000)
  })(),
  lognormal: (() => {
    const next = rng(2)
    return Array.from({ length: N }, () => Math.exp(Math.log(40) + 0.8 * normal(next)))
  })(),
  bimodal: (() => {
    const next = rng(3)
    return Array.from({ length: N }, () =>
      next() < 0.7 ? Math.max(0.2, 5 + 1.5 * normal(next)) : Math.max(0.2, 800 + 120 * normal(next)),
    )
  })(),
}

/** The exact percentile with the same rank rule as the histogram: the ceil(p% * n)-th smallest value. */
function exact(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

describe('Histogram percentiles', () => {
  for (const [name, values] of Object.entries(samples)) {
    it(`p50/p95/p99 of a ${name} sample of 100 000 are within 1 % of the exact values`, () => {
      const h = new Histogram()
      for (const v of values) h.record(v)
      const sorted = [...values].sort((a, b) => a - b)
      for (const p of [1, 25, 50, 75, 90, 95, 99, 99.9]) {
        const want = exact(sorted, p)
        const got = h.percentile(p)
        expect(Math.abs(got - want) / want, `p${p}: got ${got}, want ${want}`).toBeLessThanOrEqual(0.01)
      }
      expect(h.count).toBe(N)
      expect(h.min).toBe(sorted[0])
      expect(h.max).toBe(sorted[N - 1])
      expect(h.percentile(100)).toBe(sorted[N - 1])
      expect(h.mean).toBeCloseTo(values.reduce((a, b) => a + b, 0) / N, 6)
    })
  }

  it('merged histograms answer within 1 % of the exact values of the combined sample', () => {
    const parts = [samples.uniform, samples.lognormal, samples.bimodal]
    const merged = new Histogram()
    for (const part of parts) {
      const h = new Histogram()
      for (const v of part) h.record(v)
      merged.merge(h.toData())
    }
    const sorted = parts.flat().sort((a, b) => a - b)
    for (const p of [50, 95, 99]) {
      const want = exact(sorted, p)
      expect(Math.abs(merged.percentile(p) - want) / want).toBeLessThanOrEqual(0.01)
    }
  })

  it('never reports a percentile above the observed max or below the observed min', () => {
    const h = new Histogram()
    h.record(10.001)
    expect(h.percentile(50)).toBe(10.001)
    expect(h.percentile(99)).toBe(10.001)
    h.record(10.002)
    for (const p of [0, 50, 100]) {
      expect(h.percentile(p)).toBeGreaterThanOrEqual(10.001)
      expect(h.percentile(p)).toBeLessThanOrEqual(10.002)
    }
  })
})

describe('Histogram merge', () => {
  it('merging two histograms equals recording everything into one', () => {
    const next = rng(7)
    const a = new Histogram()
    const b = new Histogram()
    const all = new Histogram()
    for (let i = 0; i < 20_000; i++) {
      const v = Math.exp(next() * 10) / 10
      ;(i % 3 === 0 ? a : b).record(v)
      all.record(v)
    }
    const merged = Histogram.from(a.toData())
    merged.merge(b.toData())
    const m = merged.toData()
    const w = all.toData()
    expect(m.counts).toEqual(w.counts)
    expect(m.count).toBe(w.count)
    expect(m.min).toBe(w.min)
    expect(m.max).toBe(w.max)
    expect(m.sum).toBeCloseTo(w.sum, 6)
    for (const p of [50, 95, 99]) expect(merged.percentile(p)).toBe(all.percentile(p))
  })

  it('merging an empty histogram changes nothing, and merging into an empty one copies', () => {
    const h = new Histogram()
    h.record(3)
    h.record(7)
    const before = h.toData()
    h.merge(new Histogram().toData())
    expect(h.toData()).toEqual(before)

    const e = new Histogram()
    e.merge(before)
    expect(e.toData()).toEqual(before)
  })

  it('toData is a plain, structured-clone-safe copy that does not alias the histogram', () => {
    const h = new Histogram()
    h.record(12)
    const data = h.toData()
    expect(structuredClone(data)).toEqual(data)
    expect(JSON.parse(JSON.stringify(data))).toEqual(data)
    expect(Array.isArray(data.counts)).toBe(true)
    h.record(12)
    expect(data.count).toBe(1)
    const copy = Histogram.from(data)
    copy.record(50)
    expect(data.count).toBe(1)
    expect(data.counts.reduce((a, b) => a + b, 0)).toBe(1)
  })
})

describe('Histogram edge cases', () => {
  it('an empty histogram reports zeros', () => {
    const h = new Histogram()
    expect(h.count).toBe(0)
    expect(h.min).toBe(0)
    expect(h.max).toBe(0)
    expect(h.mean).toBe(0)
    for (const p of [0, 50, 99, 100]) expect(h.percentile(p)).toBe(0)
    const data = h.toData()
    expect(data).toEqual({ counts: [], count: 0, sum: 0, min: 0, max: 0 })
    expect(Histogram.from(data).percentile(50)).toBe(0)
  })

  it('clamps values below 0.1 ms into the first bucket and above 120 s into the last', () => {
    const tiny = new Histogram()
    tiny.record(0.01)
    tiny.record(0)
    expect(tiny.toData().counts).toEqual([2])
    expect(tiny.min).toBe(0)
    expect(tiny.max).toBe(0.01)

    const atTop = new Histogram()
    atTop.record(120_000)
    const huge = new Histogram()
    huge.record(500_000)
    huge.record(10_000_000)
    const top = atTop.toData().counts
    const over = huge.toData().counts
    expect(over.length).toBe(top.length)
    expect(over[over.length - 1]).toBe(2)
    expect(huge.max).toBe(10_000_000)
    expect(huge.percentile(50)).toBeGreaterThanOrEqual(120_000)
  })

  it('treats negative and NaN latencies as 0', () => {
    const h = new Histogram()
    h.record(-5)
    h.record(Number.NaN)
    expect(h.count).toBe(2)
    expect(h.min).toBe(0)
    expect(h.max).toBe(0)
    expect(h.mean).toBe(0)
  })

  it('percentile clamps p to 0..100', () => {
    const h = new Histogram()
    h.record(1)
    h.record(1000)
    expect(h.percentile(-10)).toBe(1)
    expect(h.percentile(250)).toBe(1000)
  })
})
