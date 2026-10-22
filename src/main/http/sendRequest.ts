import { STATUS_CODES } from 'node:http'
import { randomBytes } from 'node:crypto'
import { pipeline, type Readable, type Transform } from 'node:stream'
import zlib from 'node:zlib'
import { Agent, request as undiciRequest } from 'undici'
import type { HttpResponse, KeyValue, RequestItem, SendResult } from '../../shared/types'
import { parseSetCookie } from './cookies'

export interface SendOptions {
  timeoutMs?: number
  maxBodyBytes?: number
  maxRedirects?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 10
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization']
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']
const RAW_CONTENT_TYPES = { json: 'application/json', text: 'text/plain', xml: 'application/xml', html: 'text/html' }

class SendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Headers = Map<string, { name: string; value: string }>

function setHeader(headers: Headers, name: string, value: string): void {
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

function buildUrl(request: RequestItem): URL {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    throw new SendError('invalid_url', `Invalid URL: ${request.url === '' ? '(empty)' : withoutQuery(request.url)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SendError('invalid_url', `Unsupported URL scheme ${url.protocol} (only http: and https: are supported)`)
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

function applyAuth(request: RequestItem, headers: Headers): string | undefined {
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

function errorCode(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown }; errors?: { code?: unknown }[] }
  const code = e?.code ?? e?.cause?.code ?? e?.errors?.[0]?.code
  return typeof code === 'string' ? code : ''
}

const TLS_CODE = /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH|EPROTO)/

function describeError(err: unknown): { code: string; message: string } {
  const code = errorCode(err)
  const cause = (err as { cause?: Error }).cause
  const detail =
    (cause?.message && cause.message !== (err as Error).message ? cause.message : (err as Error).message) || String(err)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return { code: 'dns_failed', message: `Could not resolve host (${code})` }
  if (code === 'ECONNREFUSED') return { code: 'connection_refused', message: 'Connection refused' }
  if (TLS_CODE.test(code)) return { code: 'tls_error', message: `TLS error: ${detail}${code ? ` (${code})` : ''}` }
  return { code: 'network_error', message: code ? `${detail} (${code})` : detail }
}

function decoders(contentEncoding: string): Transform[] | null {
  const encodings = contentEncoding
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '' && e !== 'identity')
  const chain: Transform[] = []
  // Encodings are listed in the order they were applied, so undo them in reverse.
  for (const encoding of encodings.reverse()) {
    if (encoding === 'gzip' || encoding === 'x-gzip') chain.push(zlib.createGunzip())
    else if (encoding === 'deflate') chain.push(zlib.createInflate())
    else if (encoding === 'br') chain.push(zlib.createBrotliDecompress())
    else {
      for (const d of chain) d.destroy()
      return null // unknown encoding: hand back the raw bytes
    }
  }
  return chain
}

interface BodyRead {
  bytes: Buffer
  truncated: boolean
  bytesRead: number
}

async function readBody(source: Readable, maxBytes: number, decodeWith: Transform[]): Promise<BodyRead> {
  const stream: Readable =
    decodeWith.length > 0 ? (pipeline([source, ...decodeWith], () => {}) as unknown as Readable) : source
  const chunks: Buffer[] = []
  let bytesRead = 0
  let truncated = false
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer
      const room = maxBytes - bytesRead
      if (buf.length > room) {
        if (room > 0) chunks.push(buf.subarray(0, room))
        bytesRead += buf.length
        truncated = true
        break
      }
      chunks.push(buf)
      bytesRead += buf.length
    }
  } finally {
    discard(source)
    for (const d of decodeWith) discard(d)
  }
  return { bytes: Buffer.concat(chunks), truncated, bytesRead }
}

/** Destroys a stream we no longer need; the abort error undici raises on it is expected, not a failure. */
function discard(stream: Readable): void {
  stream.on('error', () => {})
  stream.destroy()
}

function toPairs(raw: unknown): [string, string][] {
  const flat = (Array.isArray(raw) ? raw : []) as (string | Buffer)[]
  const pairs: [string, string][] = []
  for (let i = 0; i + 1 < flat.length; i += 2) pairs.push([String(flat[i]), String(flat[i + 1])])
  return pairs
}

/** Sends an already-resolved request. Never throws; every failure is returned as `{ ok: false, error }`. */
export async function sendRequest(request: RequestItem, options: SendOptions = {}): Promise<SendResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const started = performance.now()

  const controller = new AbortController()
  let abortedBy: 'timeout' | 'cancelled' | null = null
  const abort = (why: 'timeout' | 'cancelled') => {
    abortedBy ??= why
    controller.abort()
  }
  const onUserAbort = () => abort('cancelled')
  const timer = setTimeout(() => abort('timeout'), timeoutMs)
  // Per-call agent: the deadline above is the only timeout, and no sockets outlive the call.
  const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 0 } })

  try {
    if (options.signal?.aborted) return fail('cancelled', 'Request was cancelled')
    options.signal?.addEventListener('abort', onUserAbort, { once: true })

    let url = buildUrl(request)
    const headers: Headers = new Map()
    for (const h of enabled(request.headers)) setHeader(headers, h.key, h.value)
    const userSetEncoding = headers.has('accept-encoding')
    if (!userSetEncoding) setHeader(headers, 'Accept-Encoding', 'gzip, deflate, br')
    const apikeyHeader = applyAuth(request, headers)
    let method: string = request.method
    const built = buildBody(request, headers)
    let body = method === 'HEAD' ? undefined : built

    for (let redirects = 0; ; redirects++) {
      const flat: Record<string, string> = {}
      for (const [lower, h] of headers) flat[lower] = h.value
      const res = await undiciRequest(url, {
        method: method as 'GET',
        headers: flat,
        body,
        signal: controller.signal,
        dispatcher: agent,
        responseHeaders: 'raw',
      })
      const rawHeaders = toPairs(res.headers)
      const status = res.statusCode
      const header = (name: string) => rawHeaders.find(([n]) => n.toLowerCase() === name)?.[1]

      const location = header('location')
      if (REDIRECT_STATUSES.has(status) && location !== undefined) {
        discard(res.body)
        if (redirects >= maxRedirects) {
          return fail('too_many_redirects', `Stopped after ${maxRedirects} redirects`)
        }
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          return fail('invalid_url', `Redirect to an invalid URL: ${location}`)
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return fail('invalid_url', `Refusing to follow redirect to ${next.protocol} URL (only http: and https:)`)
        }
        if (next.origin !== url.origin) {
          for (const name of [...CREDENTIAL_HEADERS, ...(apikeyHeader ? [apikeyHeader] : [])]) headers.delete(name)
        }
        const toGet = status === 303 ? method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST'
        if (toGet) {
          method = 'GET'
          body = undefined
          for (const name of BODY_HEADERS) headers.delete(name)
        }
        url = next
        continue
      }

      const bodyless = method === 'HEAD' || status === 204 || status === 304
      let bytes: Buffer = Buffer.alloc(0)
      let truncated = false
      let sizeBytes = 0
      if (bodyless) {
        discard(res.body)
      } else {
        const contentEncoding = header('content-encoding') ?? ''
        const chain = userSetEncoding ? [] : decoders(contentEncoding)
        const decoded = chain !== null && chain.length > 0
        const read = await readBody(res.body, maxBodyBytes, chain ?? [])
        bytes = read.bytes
        truncated = read.truncated
        const contentLength = Number(header('content-length'))
        sizeBytes =
          !truncated || decoded || header('content-length') === undefined || Number.isNaN(contentLength)
            ? read.bytesRead
            : contentLength
      }

      const response: HttpResponse = {
        status,
        statusText: STATUS_CODES[status] ?? '',
        headers: rawHeaders,
        bodyBase64: bytes.toString('base64'),
        bodyTruncated: truncated,
        sizeBytes,
        totalMs: performance.now() - started,
        finalUrl: url.toString(),
        redirects,
        cookies: rawHeaders.filter(([n]) => n.toLowerCase() === 'set-cookie').map(([, v]) => parseSetCookie(v)),
      }
      return { ok: true, response }
    }
  } catch (err) {
    if (abortedBy === 'timeout') return fail('timeout', `Request timed out after ${timeoutMs} ms`)
    if (abortedBy === 'cancelled') return fail('cancelled', 'Request was cancelled')
    if (err instanceof SendError) return fail(err.code, err.message)
    const { code, message } = describeError(err)
    return fail(code, message)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onUserAbort)
    await agent.destroy().catch(() => {})
  }
}

function fail(code: string, message: string): SendResult {
  return { ok: false, error: { code, message } }
}
