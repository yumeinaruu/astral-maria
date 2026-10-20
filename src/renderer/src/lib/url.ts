import type { KeyValue } from '../../../shared/types'

const VARIABLE = /(\{\{[^{}]*\}\})/

/** Applies `fn` to the text between `{{variables}}`; the variables themselves are never touched. */
function mapOutsideVariables(text: string, fn: (part: string) => string): string {
  return text
    .split(VARIABLE)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('')
}

function encode(text: string): string {
  return mapOutsideVariables(text, (part) => {
    try {
      return encodeURIComponent(part)
    } catch {
      return part // lone surrogate: nothing sensible to encode
    }
  })
}

function decode(text: string): string {
  return mapOutsideVariables(text, (part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part // not a valid escape sequence: keep what the user typed
    }
  })
}

/** The base URL with the enabled params appended as a query string (before any `#fragment`). */
export function composeUrl(base: string, params: KeyValue[]): string {
  const pairs = params
    .filter((p) => p.enabled && (p.key !== '' || p.value !== ''))
    .map((p) => `${encode(p.key)}=${encode(p.value)}`)
  if (pairs.length === 0) return base
  const hash = base.indexOf('#')
  const path = hash < 0 ? base : base.slice(0, hash)
  const fragment = hash < 0 ? '' : base.slice(hash)
  return `${path}${path.includes('?') ? '&' : '?'}${pairs.join('&')}${fragment}`
}

/**
 * Splits a full URL typed in the URL bar into the base URL and the query params. Disabled params of `existing` are
 * not part of the URL bar, so they are kept (after the enabled ones); enabled params keep their description.
 */
export function splitUrl(full: string, existing: KeyValue[]): { url: string; params: KeyValue[] } {
  const hash = full.indexOf('#')
  const beforeHash = hash < 0 ? full : full.slice(0, hash)
  const fragment = hash < 0 ? '' : full.slice(hash)
  const q = beforeHash.indexOf('?')
  const path = q < 0 ? beforeHash : beforeHash.slice(0, q)
  const query = q < 0 ? '' : beforeHash.slice(q + 1)

  const previous = existing.filter((p) => p.enabled)
  const parsed: KeyValue[] =
    query === ''
      ? []
      : query
          .split('&')
          .filter((pair) => pair !== '')
          .map((pair, i) => {
            const eq = pair.indexOf('=')
            const key = decode(eq < 0 ? pair : pair.slice(0, eq))
            const value = decode(eq < 0 ? '' : pair.slice(eq + 1))
            const description = previous[i]?.key === key ? previous[i].description : undefined
            return description === undefined
              ? { key, value, enabled: true }
              : { key, value, enabled: true, description }
          })
  return { url: path + fragment, params: [...parsed, ...existing.filter((p) => !p.enabled)] }
}
