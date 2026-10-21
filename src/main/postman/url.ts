import { encode } from '../../shared/queryCodec'
import type { KeyValue } from '../../shared/types'

/** The URL object of a Postman Collection v2.1 request. */
export interface PostmanUrl {
  raw: string
  protocol?: string
  host?: string[]
  port?: string
  path?: string[]
  query?: { key: string; value: string; disabled?: boolean; description?: string }[]
}

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

/** Splits `raw` at its `#fragment`; the fragment keeps its `#`. */
function cutFragment(raw: string): [string, string] {
  const hash = indexOutside(raw, '#')
  return hash < 0 ? [raw, ''] : [raw.slice(0, hash), raw.slice(hash)]
}

/**
 * Splits a Postman `raw` URL into the base URL (keeping any `#fragment`) and enabled query params. Keys and values
 * are returned as written; the importer decodes them.
 */
export function splitQuery(raw: string): { url: string; params: KeyValue[] } {
  const [beforeHash, fragment] = cutFragment(raw)
  const q = indexOutside(beforeHash, '?')
  if (q < 0) return { url: raw, params: [] }
  const params = splitOutside(beforeHash.slice(q + 1), '&')
    .filter((pair) => pair !== '')
    .map((pair): KeyValue => {
      const eq = indexOutside(pair, '=')
      return eq < 0
        ? { key: pair, value: '', enabled: true }
        : { key: pair.slice(0, eq), value: pair.slice(eq + 1), enabled: true }
    })
  return { url: beforeHash.slice(0, q) + fragment, params }
}

const PROTOCOL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//

/** Builds a Postman URL object from a base URL and decoded params; `raw` carries only the enabled params, encoded. */
export function toPostmanUrl(url: string, params: KeyValue[]): PostmanUrl {
  const [base, fragment] = cutFragment(url)
  const pairs = params
    .filter((p) => p.enabled && (p.key !== '' || p.value !== ''))
    .map((p) => `${encode(p.key)}=${encode(p.value)}`)
  const raw =
    pairs.length === 0 ? url : `${base}${indexOutside(base, '?') >= 0 ? '&' : '?'}${pairs.join('&')}${fragment}`
  const result: PostmanUrl = { raw }

  let rest = base
  const protocol = PROTOCOL.exec(rest)
  if (protocol) {
    result.protocol = protocol[1]
    rest = rest.slice(protocol[0].length)
  }
  const q = indexOutside(rest, '?')
  if (q >= 0) rest = rest.slice(0, q)
  const slash = indexOutside(rest, '/')
  let authority = slash < 0 ? rest : rest.slice(0, slash)
  const pathText = slash < 0 ? '' : rest.slice(slash + 1)

  const port = /:(\d+)$/.exec(authority)
  if (port) {
    result.port = port[1]
    authority = authority.slice(0, port.index)
  }
  if (authority !== '') result.host = splitOutside(authority, '.')
  if (pathText !== '') result.path = splitOutside(pathText, '/')
  if (params.length > 0) {
    result.query = params.map((p) => ({
      key: encode(p.key),
      value: encode(p.value),
      ...(p.enabled ? {} : { disabled: true }),
      ...(p.description === undefined ? {} : { description: p.description }),
    }))
  }
  return result
}
