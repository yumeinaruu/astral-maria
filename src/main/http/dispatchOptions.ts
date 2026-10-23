import { randomBytes } from 'node:crypto'
import type { KeyValue, RequestItem } from '../../shared/types'

// How a resolved request becomes what undici sends: the URL with its query, the headers (auth and the body's
// content type included) and the body bytes. `sendRequest` and the load test workers both build from here, so a
// load test sends the same bytes and headers as Send.

export const RAW_CONTENT_TYPES = { json: 'application/json', text: 'text/plain', xml: 'application/xml', html: 'text/html' }

/** A request that cannot be sent as written (e.g. `invalid_url`). */
export class DispatchError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Header values by lower-case name; `name` keeps the spelling of the first one set. */
export type Headers = Map<string, { name: string; value: string }>

export function setHeader(headers: Headers, name: string, value: string): void {
  const lower = name.toLowerCase()
  const existing = headers.get(lower)
  const separator = lower === 'cookie' ? '; ' : ', '
  headers.set(lower, { name, value: existing ? `${existing.value}${separator}${value}` : value })
}

function enabled(rows: KeyValue[]): KeyValue[] {
  return rows.filter((row) => row.enabled && row.key !== '')
}

const encode = encodeURIComponent

/** The query (and fragment) may carry resolved secrets, so messages only show what comes before it. */
function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/)
  return cut < 0 ? url : `${url.slice(0, cut)}?…`
}

/** The URL a resolved request goes to, query included; the request's own URL when it is not a valid one. */
export function requestUrl(request: RequestItem): string {
  try {
    return buildUrl(request).toString()
  } catch {
    return request.url
  }
}

/** The URL with the enabled params (and an API key sent in the query); throws `DispatchError` (`invalid_url`). */
export function buildUrl(request: RequestItem): URL {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    throw new DispatchError('invalid_url', `Invalid URL: ${request.url === '' ? '(empty)' : withoutQuery(request.url)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DispatchError(
      'invalid_url',
      `Unsupported URL scheme ${url.protocol} (only http: and https: are supported)`,
    )
  }
  const pairs = enabled(request.params).map((p): [string, string] => [p.key, p.value])
  if (request.auth.type === 'apikey' && request.auth.in === 'query' && request.auth.key !== '') {
    pairs.push([request.auth.key, request.auth.value])
  }
  if (pairs.length > 0) {
    const query = pairs.map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&')
    url.search = url.search === '' || url.search === '?' ? query : `${url.search.slice(1)}&${query}`
  }
  return url
}

function buildBody(request: RequestItem, headers: Headers): string | Buffer | undefined {
  const body = request.body
  const defaultType = (type: string) => {
    if (!headers.has('content-type')) setHeader(headers, 'Content-Type', type)
  }
  switch (body.mode) {
    case 'none':
      return undefined
    case 'raw':
      defaultType(RAW_CONTENT_TYPES[body.language])
      return body.content
    case 'urlencoded':
      defaultType('application/x-www-form-urlencoded')
      return enabled(body.fields)
        .map((f) => `${encode(f.key)}=${encode(f.value)}`)
        .join('&')
    case 'formdata': {
      // The boundary must match the body, so this header is always generated.
      const boundary = `----AstralMaria${randomBytes(12).toString('hex')}`
      headers.delete('content-type')
      setHeader(headers, 'Content-Type', `multipart/form-data; boundary=${boundary}`)
      const quote = (s: string) => s.replace(/[\r\n"]/g, (c) => ({ '\r': '%0D', '\n': '%0A', '"': '%22' })[c] as string)
      const parts = enabled(body.fields).map(
        (f) => `--${boundary}\r\nContent-Disposition: form-data; name="${quote(f.key)}"\r\n\r\n${f.value}\r\n`,
      )
      return Buffer.from(`${parts.join('')}--${boundary}--\r\n`, 'utf8')
    }
  }
}

/** Adds the auth header (unless the user set it); returns the lower-case name of an API key header. */
export function applyAuth(request: RequestItem, headers: Headers): string | undefined {
  const auth = request.auth
  const addIfAbsent = (name: string, value: string) => {
    if (!headers.has(name.toLowerCase())) setHeader(headers, name, value)
  }
  if (auth.type === 'bearer') {
    addIfAbsent('Authorization', `Bearer ${auth.token}`)
  } else if (auth.type === 'basic') {
    addIfAbsent('Authorization', `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`)
  } else if (auth.type === 'apikey' && auth.in === 'header' && auth.key !== '') {
    addIfAbsent(auth.key, auth.value)
    return auth.key.toLowerCase()
  }
  return undefined
}

/** A request ready to dispatch; `sendRequest` keeps the header map to edit it across redirects. */
export interface PreparedRequest {
  url: URL
  method: string
  headers: Headers
  /** Undefined for HEAD and for a request without a body. */
  body: string | Buffer | undefined
  /** The user set Accept-Encoding, so the response is handed back as received, not decoded. */
  userSetEncoding: boolean
  /** The lower-case name of the API key header added by auth, if any. */
  apikeyHeader: string | undefined
}

/** Throws `DispatchError` (`invalid_url`) when the URL cannot be sent. */
export function prepareRequest(request: RequestItem): PreparedRequest {
  const url = buildUrl(request)
  const headers: Headers = new Map()
  for (const h of enabled(request.headers)) setHeader(headers, h.key, h.value)
  const userSetEncoding = headers.has('accept-encoding')
  if (!userSetEncoding) setHeader(headers, 'Accept-Encoding', 'gzip, deflate, br')
  const apikeyHeader = applyAuth(request, headers)
  const method: string = request.method
  const built = buildBody(request, headers)
  return { url, method, headers, body: method === 'HEAD' ? undefined : built, userSetEncoding, apikeyHeader }
}

/** The headers as undici takes them, by lower-case name. */
export function flatHeaders(headers: Headers): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [lower, h] of headers) flat[lower] = h.value
  return flat
}

export interface DispatchSpec {
  origin: string
  path: string
  method: string
  headers: Record<string, string | string[]>
  body?: Buffer | string
}

/**
 * The undici `dispatch`/`request` options of a resolved request, as `sendRequest` sends it before any redirect.
 * Throws `DispatchError` (`invalid_url`) when the URL cannot be sent.
 */
export function toDispatch(request: RequestItem): DispatchSpec {
  const prepared = prepareRequest(request)
  const spec: DispatchSpec = {
    origin: prepared.url.origin,
    path: `${prepared.url.pathname}${prepared.url.search}`,
    method: prepared.method,
    headers: flatHeaders(prepared.headers),
  }
  if (prepared.body !== undefined) spec.body = prepared.body
  return spec
}
