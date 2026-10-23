/**
 * A mergeable log-linear latency histogram. Values are kept in units of 0.1 ms; every power-of-two range of units is
 * split into SUB_BUCKETS equal buckets, so a bucket is at most 1/128 (< 0.8 %) of its lower bound wide. Percentiles
 * are read from the bucket upper bound and clamped to the observed min and max.
 *
 * Snapshots are plain data (`HistogramData`), so they cross `postMessage` and JSON unchanged, and two snapshots merge
 * by summing their counts.
 */

const UNIT_MS = 0.1
const MAX_MS = 120_000
const MAX_UNITS = MAX_MS / UNIT_MS
const SUB_BITS = 7
const SUB_BUCKETS = 1 << SUB_BITS

export interface HistogramData {
  /** Count per bucket; trailing empty buckets are left out, so the length varies. */
  counts: number[]
  count: number
  /** Sum of the recorded values in ms. */
  sum: number
  /** Observed min and max in ms, 0 when empty. */
  min: number
  max: number
}

function bucketIndex(ms: number): number {
  const units = Math.min(Math.max(ms / UNIT_MS, 1), MAX_UNITS)
  let octave = Math.floor(Math.log2(units))
  // Math.log2 may be off by one ulp around powers of two.
  if (2 ** octave > units) octave--
  else if (2 ** (octave + 1) <= units) octave++
  const sub = Math.min(SUB_BUCKETS - 1, Math.floor((units / 2 ** octave - 1) * SUB_BUCKETS))
  return octave * SUB_BUCKETS + sub
}

function bucketUpperMs(index: number): number {
  const octave = Math.floor(index / SUB_BUCKETS)
  const sub = index % SUB_BUCKETS
  return 2 ** octave * (1 + (sub + 1) / SUB_BUCKETS) * UNIT_MS
}

export class Histogram {
  private counts: number[] = []
  private total = 0
  private sum = 0
  private lo = 0
  private hi = 0

  /** Records a latency in ms. Negative or NaN values count as 0; values outside 0.1 ms–120 s land in the end buckets. */
  record(ms: number): void {
    const v = ms >= 0 ? ms : 0
    const i = bucketIndex(v)
    while (this.counts.length <= i) this.counts.push(0)
    this.counts[i]++
    this.lo = this.total === 0 ? v : Math.min(this.lo, v)
    this.hi = this.total === 0 ? v : Math.max(this.hi, v)
    this.total++
    this.sum += v
  }

  merge(other: HistogramData): void {
    if (other.count === 0) return
    while (this.counts.length < other.counts.length) this.counts.push(0)
    for (let i = 0; i < other.counts.length; i++) this.counts[i] += other.counts[i]
    this.lo = this.total === 0 ? other.min : Math.min(this.lo, other.min)
    this.hi = this.total === 0 ? other.max : Math.max(this.hi, other.max)
    this.total += other.count
    this.sum += other.sum
  }

  /** `p` is 0..100 (clamped); 0 gives the min. Returns 0 when empty. */
  percentile(p: number): number {
    if (this.total === 0) return 0
    const q = Math.min(Math.max(p, 0), 100)
    if (q === 0) return this.lo
    const rank = Math.max(1, Math.ceil((q / 100) * this.total))
    let seen = 0
    for (let i = 0; i < this.counts.length; i++) {
      seen += this.counts[i]
      if (seen >= rank) return Math.min(Math.max(bucketUpperMs(i), this.lo), this.hi)
    }
    return this.hi
  }

  get count(): number {
    return this.total
  }

  get min(): number {
    return this.lo
  }

  get max(): number {
    return this.hi
  }

  get mean(): number {
    return this.total === 0 ? 0 : this.sum / this.total
  }

  toData(): HistogramData {
    return { counts: this.counts.slice(), count: this.total, sum: this.sum, min: this.lo, max: this.hi }
  }

  static from(data: HistogramData): Histogram {
    const h = new Histogram()
    h.merge(data)
    return h
  }
}
