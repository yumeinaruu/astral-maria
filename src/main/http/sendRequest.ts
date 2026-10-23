import { STATUS_CODES } from 'node:http'
import { pipeline, type Readable, type Transform } from 'node:stream'
import zlib from 'node:zlib'
import { Agent, request as undiciRequest } from 'undici'
import type { HttpResponse, RequestItem, SendResult } from '../../shared/types'
import { parseSetCookie } from './cookies'
import { DispatchError, flatHeaders, prepareRequest } from './dispatchOptions'

export { requestUrl } from './dispatchOptions'

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

    const prepared = prepareRequest(request)
    const { headers, userSetEncoding, apikeyHeader } = prepared
    let { url, method, body } = prepared

    for (let redirects = 0; ; redirects++) {
      const res = await undiciRequest(url, {
        method: method as 'GET',
        headers: flatHeaders(headers),
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
    if (err instanceof DispatchError) return fail(err.code, err.message)
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
