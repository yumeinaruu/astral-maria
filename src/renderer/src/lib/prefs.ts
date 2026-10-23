/**
 * Per-machine UI preferences in localStorage. Storage can be missing or throw (private mode, blocked site data), so
 * every access is guarded and a default is used instead.
 */
const PREFIX = 'astral.'

export function readPref<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + key)
    if (raw === null || raw === undefined) return fallback
    const value: unknown = JSON.parse(raw)
    return valid(value) ? value : fallback
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Not persisted; the value still applies for this session.
  }
}

export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export function oneOf<T extends string>(...options: T[]): (v: unknown) => v is T {
  return (v: unknown): v is T => typeof v === 'string' && (options as string[]).includes(v)
}

const LOAD_HOSTS_KEY = 'loadConfirmedHosts'
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** Confirmed in this session; kept even when storage is unavailable. */
const sessionLoadHosts = new Set<string>()

/** The hosts the user confirmed they may load-test (asked once per host; see the load test's host check). */
export function confirmedLoadHosts(): string[] {
  return [...new Set([...readPref(LOAD_HOSTS_KEY, [], isStringList), ...sessionLoadHosts])]
}

export function confirmLoadHosts(hosts: string[]): void {
  for (const h of hosts) sessionLoadHosts.add(h)
  writePref(LOAD_HOSTS_KEY, confirmedLoadHosts())
}
