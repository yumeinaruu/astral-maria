import { decode, encode } from '../../../shared/queryCodec'
import type { KeyValue } from '../../../shared/types'

const VARIABLE_AT = /\{\{[^{}]*\}\}/y

/** Index of the first `ch` in `text` from `from` on that is not inside a `{{variable}}`, or -1. */
function indexOutside(text: string, ch: string, from = 0): number {
  for (let i = from; i < text.length; i++) {
    if (text.startsWith('{{', i)) {
      VARIABLE_AT.lastIndex = i
      if (VARIABLE_AT.test(text)) {
        i = VARIABLE_AT.lastIndex - 1
        continue
      }
    }
    if (text[i] === ch) return i
  }
  return -1
}

/** Splits `text` on `ch`, ignoring occurrences inside `{{variables}}`. */
function splitOutside(text: string, ch: string): string[] {
  const parts: string[] = []
  let start = 0
  for (let at = indexOutside(text, ch); at >= 0; at = indexOutside(text, ch, start)) {
    parts.push(text.slice(start, at))
    start = at + 1
  }
  parts.push(text.slice(start))
  return parts
}

/** The base URL with the enabled params appended as a query string (before any `#fragment`). */
export function composeUrl(base: string, params: KeyValue[]): string {
  const pairs = params
    .filter((p) => p.enabled && (p.key !== '' || p.value !== ''))
    .map((p) => `${encode(p.key)}=${encode(p.value)}`)
  if (pairs.length === 0) return base
  const hash = indexOutside(base, '#')
  const path = hash < 0 ? base : base.slice(0, hash)
  const fragment = hash < 0 ? '' : base.slice(hash)
  return `${path}${indexOutside(path, '?') >= 0 ? '&' : '?'}${pairs.join('&')}${fragment}`
}

/**
 * Splits a full URL typed in the URL bar into the base URL and the query params. Disabled params of `existing` are
 * not part of the URL bar, so they are kept (after the enabled ones); enabled params keep their description.
 */
export function splitUrl(full: string, existing: KeyValue[]): { url: string; params: KeyValue[] } {
  const hash = indexOutside(full, '#')
  const beforeHash = hash < 0 ? full : full.slice(0, hash)
  const fragment = hash < 0 ? '' : full.slice(hash)
  const q = indexOutside(beforeHash, '?')
  const path = q < 0 ? beforeHash : beforeHash.slice(0, q)
  const query = q < 0 ? '' : beforeHash.slice(q + 1)

  const previous = existing.filter((p) => p.enabled)
  const parsed: KeyValue[] =
    query === ''
      ? []
      : splitOutside(query, '&')
          .filter((pair) => pair !== '')
          .map((pair, i) => {
            const eq = indexOutside(pair, '=')
            const key = decode(eq < 0 ? pair : pair.slice(0, eq))
            const value = decode(eq < 0 ? '' : pair.slice(eq + 1))
            const description = previous[i]?.key === key ? previous[i].description : undefined
            return description === undefined
              ? { key, value, enabled: true }
              : { key, value, enabled: true, description }
          })
  return { url: path + fragment, params: [...parsed, ...existing.filter((p) => !p.enabled)] }
}
