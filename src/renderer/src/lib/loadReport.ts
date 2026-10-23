import type { HttpMethod, LoadOptions, LoadStopReason, LoadTick, LoadTotals } from '../../../shared/types'
import { stampedFileName } from './runReport'

/** One request a load test sends; the URL has secrets masked. */
export interface LoadTargetRequest {
  name: string
  method: HttpMethod
  url: string
}

/** What a load test's report says about it besides its numbers. */
export interface LoadMeta {
  target: { name: string; path: string; requests: LoadTargetRequest[] }
  environment: string | null
  startedAt: string
}

/** The exported report of a load test. */
export interface LoadReport {
  target: LoadMeta['target']
  environment: string | null
  options: LoadOptions
  startedAt: string
  durationMs: number
  reason: LoadStopReason
  /** Set when `reason` is `error`. */
  message?: string
  totals: LoadTotals
  ticks: LoadTick[]
}

export function buildLoadReport(
  meta: LoadMeta,
  test: {
    options: LoadOptions
    totals: LoadTotals
    ticks: LoadTick[]
    finished: { reason: LoadStopReason; message?: string; durationMs: number }
  },
): LoadReport {
  return {
    target: meta.target,
    environment: meta.environment,
    options: test.options,
    startedAt: meta.startedAt,
    durationMs: test.finished.durationMs,
    reason: test.finished.reason,
    ...(test.finished.message !== undefined ? { message: test.finished.message } : {}),
    totals: test.totals,
    ticks: test.ticks,
  }
}

/** `<name>-load-<yyyy-mm-dd-hhmmss>.json`, the time in UTC. */
export function loadReportFileName(name: string, startedAt: string): string {
  return stampedFileName(name, 'load', startedAt)
}

const group = (n: number): string => n.toLocaleString('en-US').replace(/,/g, ' ')

/** A count, with thin groups: `12 345`. */
export function formatCount(n: number): string {
  return group(Math.round(n))
}

/** A latency in ms: one decimal below 10, whole numbers above. */
export function formatMs(ms: number): string {
  return ms < 10 ? ms.toFixed(1) : group(Math.round(ms))
}

/** Requests per second, one decimal. */
export function formatRps(rps: number): string {
  return rps >= 1000 ? group(Math.round(rps)) : rps.toFixed(1)
}

/** A 0..1 fraction as a percentage with at most one decimal: `0%`, `1.7%`, `100%`. */
export function formatPercent(fraction: number): string {
  return `${Number((fraction * 100).toFixed(1))}%`
}

function ipv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null
  const bytes = parts.map(Number)
  return bytes.every((b) => b <= 255) ? bytes : null
}

/**
 * True for loopback, private, link-local and unspecified addresses, and for `localhost` names: hosts that need no
 * confirmation before a load test. `host` is a URL hostname (IPv6 with or without brackets).
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const v4 = ipv4(host)
  if (v4) {
    const [a, b] = v4 as [number, number, number, number]
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  if (!host.includes(':')) return false
  if (host === '::1' || host === '::') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
  if (mapped) return isLocalHost(mapped[1]!)
  // fc00::/7 (unique local) and fe80::/10 (link-local).
  return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)
}

/**
 * Replaces each `{{name}}` that `lookup` resolves with its value, as sending does once; unknown names stay as typed.
 * Only for showing the targets and checking their hosts: main resolves the requests it sends.
 */
export function resolveTemplate(text: string, lookup: (name: string) => { value: string } | null): string {
  return text.replace(/\{\{([^{}]*)\}\}/g, (token, inner: string) => {
    const name = inner.trim()
    return /\s/.test(name) ? token : (lookup(name)?.value ?? token)
  })
}

/** The hostname of `url` (`http://` assumed when there is no scheme), lower-case; null when it cannot be parsed. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `http://${url}`)
    return parsed.hostname ? parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '') : null
  } catch {
    return null
  }
}
