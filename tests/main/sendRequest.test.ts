import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { parseSetCookie } from '../../src/main/http/cookies'
import { sendRequest } from '../../src/main/http/sendRequest'
import type { HttpResponse, RequestItem } from '../../src/shared/types'
import { testCert, testKey } from '../fixtures/selfSigned'

const MIB = 1024 * 1024

function req(overrides: Partial<RequestItem> = {}): RequestItem {
  return {
    id: 'r1',
    name: 'r',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  }
}

const kv = (key: string, value: string, enabled = true) => ({ key, value, enabled })

interface Echo {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

async function readBody(r: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of r) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function listen(server: http.Server | https.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

function close(server: http.Server | https.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

function ok(response: unknown): HttpResponse {
  const r = response as { ok: boolean; response?: HttpResponse; error?: { code: string; message: string } }
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`)
  return r.response as HttpResponse
}

const text = (r: HttpResponse) => Buffer.from(r.bodyBase64, 'base64').toString('utf8')
const echoOf = (r: HttpResponse) => JSON.parse(text(r)) as Echo

let base = ''
let other = ''
let tlsBase = ''
let server: http.Server
let otherServer: http.Server
let tlsServer: https.Server

beforeAll(async () => {
  otherServer = http.createServer(async (rq, rs) => {
    const body = await readBody(rq)
    rs.setHeader('content-type', 'application/json')
    rs.end(JSON.stringify({ method: rq.method ?? '', url: rq.url ?? '', headers: rq.headers, body } satisfies Echo))
  })
  const otherPort = await listen(otherServer)
  other = `http://127.0.0.1:${otherPort}`

  server = http.createServer(async (rq, rs) => {
    const url = new URL(rq.url ?? '/', 'http://x')
    const path = url.pathname
    if (path === '/echo') {
      const body = await readBody(rq)
      rs.setHeader('content-type', 'application/json')
      rs.end(JSON.stringify({ method: rq.method ?? '', url: rq.url ?? '', headers: rq.headers, body } satisfies Echo))
    } else if (path === '/json') {
      rs.setHeader('content-type', 'application/json')
      rs.end('{"hello":"world"}')
    } else if (path === '/hop') {
      const n = Number(url.searchParams.get('n'))
      rs.statusCode = 302
      rs.setHeader('location', n > 1 ? `/hop?n=${n - 1}` : '/echo?done=1')
      rs.end()
    } else if (path === '/loop') {
      rs.statusCode = 302
      rs.setHeader('location', '/loop')
      rs.end()
    } else if (path === '/redir') {
      rs.statusCode = Number(url.searchParams.get('code'))
      rs.setHeader('location', url.searchParams.get('to') ?? '/echo')
      rs.end()
    } else if (path === '/hang') {
      // never answers
    } else if (path === '/slowbody') {
      rs.writeHead(200, { 'content-type': 'text/plain' })
      rs.write('start')
      // never ends
    } else if (path === '/big') {
      rs.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(30 * MIB) })
      const chunk = Buffer.alloc(MIB, 1)
      let sent = 0
      const pump = () => {
        while (sent < 30) {
          sent++
          if (!rs.write(chunk)) {
            rs.once('drain', pump)
            return
          }
        }
        rs.end()
      }
      pump()
    } else if (path === '/bigchunked') {
      rs.writeHead(200, { 'content-type': 'application/octet-stream' })
      const chunk = Buffer.alloc(MIB, 1)
      let sent = 0
      const pump = () => {
        while (sent < 30) {
          sent++
          if (!rs.write(chunk)) {
            rs.once('drain', pump)
            return
          }
        }
        rs.end()
      }
      pump()
    } else if (path === '/bytes') {
      rs.setHeader('content-type', 'application/octet-stream')
      rs.end(Buffer.from([0xff, 0xfe, 0x00, 0x80]))
    } else if (path === '/cookies') {
      rs.setHeader('set-cookie', ['a=1; Path=/; HttpOnly', 'b=2; Max-Age=60'])
      rs.setHeader('x-dup', ['one', 'two'])
      rs.end('ok')
    } else if (path === '/gzip') {
      rs.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' })
      rs.end(zlib.gzipSync('gzipped hello'))
    } else if (path === '/deflate') {
      rs.writeHead(200, { 'content-encoding': 'deflate' })
      rs.end(zlib.deflateSync('deflated hello'))
    } else if (path === '/br') {
      rs.writeHead(200, { 'content-encoding': 'br' })
      rs.end(zlib.brotliCompressSync('brotli hello'))
    } else if (path === '/bomb') {
      const body = zlib.gzipSync(Buffer.alloc(50 * MIB, 0))
      rs.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(body.length) })
      rs.end(body)
    } else if (path === '/head') {
      rs.setHeader('content-length', '1234')
      rs.end('ignored for head')
    } else if (path === '/204') {
      rs.statusCode = 204
      rs.end()
    } else if (path === '/teapot') {
      rs.statusCode = 418
      rs.end('short and stout')
    } else {
      rs.statusCode = 404
      rs.end('nope')
    }
  })
  const port = await listen(server)
  base = `http://127.0.0.1:${port}`

  tlsServer = https.createServer({ key: testKey, cert: testCert }, (_rq, rs) => rs.end('secure'))
  tlsBase = `https://127.0.0.1:${await listen(tlsServer)}`
})

afterAll(async () => {
  await Promise.all([close(server), close(otherServer), close(tlsServer)])
})

describe('sendRequest basics', () => {
  it('returns status, headers, decoded body and timing for a GET', async () => {
    const r = ok(await sendRequest(req({ url: `${base}/json` })))
    expect(r.status).toBe(200)
    expect(r.statusText).toBe('OK')
    expect(r.headers).toContainEqual(['content-type', 'application/json'])
    expect(JSON.parse(text(r))).toEqual({ hello: 'world' })
    expect(r.sizeBytes).toBe(17)
    expect(r.totalMs).toBeGreaterThan(0)
    expect(r.finalUrl).toBe(`${base}/json`)
    expect(r.redirects).toBe(0)
    expect(r.bodyTruncated).toBe(false)
  })

  it('takes statusText from node:http STATUS_CODES', async () => {
    const r = ok(await sendRequest(req({ url: `${base}/teapot` })))
    expect(r.status).toBe(418)
    expect(r.statusText).toBe("I'm a Teapot")
  })

  it('returns invalid_url for garbage and for unsupported schemes', async () => {
    for (const url of ['not a url', '', 'ftp://example.com/x', 'file:///etc/passwd']) {
      const r = await sendRequest(req({ url }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('invalid_url')
    }
  })
})

describe('params, headers, bodies and auth', () => {
  it('sends enabled params (percent-encoded) and skips disabled ones, keeping an existing query', async () => {
    const r = ok(
      await sendRequest(
        req({ url: `${base}/echo?fixed=1`, params: [kv('q', 'a b&c=é'), kv('off', 'x', false), kv('sp ace', 'v')] }),
      ),
    )
    const url = echoOf(r).url
    expect(url).toBe('/echo?fixed=1&q=a%20b%26c%3D%C3%A9&sp%20ace=v')
  })

  it('sends only enabled headers', async () => {
    const r = ok(await sendRequest(req({ url: `${base}/echo`, headers: [kv('X-On', '1'), kv('X-Off', '2', false)] })))
    const headers = echoOf(r).headers
    expect(headers['x-on']).toBe('1')
    expect(headers['x-off']).toBeUndefined()
  })

  it('sends bearer, basic and apikey auth', async () => {
    const bearer = echoOf(ok(await sendRequest(req({ url: `${base}/echo`, auth: { type: 'bearer', token: 'tok' } }))))
    expect(bearer.headers.authorization).toBe('Bearer tok')

    const basic = echoOf(
      ok(await sendRequest(req({ url: `${base}/echo`, auth: { type: 'basic', username: 'ü', password: 'p:w' } }))),
    )
    expect(basic.headers.authorization).toBe(`Basic ${Buffer.from('ü:p:w', 'utf8').toString('base64')}`)

    const header = echoOf(
      ok(
        await sendRequest(
          req({ url: `${base}/echo`, auth: { type: 'apikey', key: 'X-Key', value: 'v1', in: 'header' } }),
        ),
      ),
    )
    expect(header.headers['x-key']).toBe('v1')

    const query = echoOf(
      ok(
        await sendRequest(
          req({
            url: `${base}/echo`,
            params: [kv('a', '1')],
            auth: { type: 'apikey', key: 'api key', value: 'v 2', in: 'query' },
          }),
        ),
      ),
    )
    expect(query.url).toBe('/echo?a=1&api%20key=v%202')
  })

  it('sends a raw JSON body with a matching content-type', async () => {
    const r = ok(
      await sendRequest(
        req({ method: 'POST', url: `${base}/echo`, body: { mode: 'raw', language: 'json', content: '{"a":1}' } }),
      ),
    )
    const e = echoOf(r)
    expect(e.method).toBe('POST')
    expect(e.body).toBe('{"a":1}')
    expect(e.headers['content-type']).toBe('application/json')
  })

  it('maps raw languages to content types and never overrides a user Content-Type', async () => {
    const xml = echoOf(
      ok(
        await sendRequest(
          req({ method: 'POST', url: `${base}/echo`, body: { mode: 'raw', language: 'xml', content: '<a/>' } }),
        ),
      ),
    )
    expect(xml.headers['content-type']).toBe('application/xml')

    const own = echoOf(
      ok(
        await sendRequest(
          req({
            method: 'POST',
            url: `${base}/echo`,
            headers: [kv('content-type', 'application/vnd.custom+json')],
            body: { mode: 'raw', language: 'json', content: '{}' },
          }),
        ),
      ),
    )
    expect(own.headers['content-type']).toBe('application/vnd.custom+json')
  })

  it('encodes urlencoded bodies', async () => {
    const r = ok(
      await sendRequest(
        req({
          method: 'POST',
          url: `${base}/echo`,
          body: { mode: 'urlencoded', fields: [kv('a', 'x y'), kv('b', '&=é'), kv('off', '1', false)] },
        }),
      ),
    )
    const e = echoOf(r)
    expect(e.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(new URLSearchParams(e.body).get('a')).toBe('x y')
    expect(new URLSearchParams(e.body).get('b')).toBe('&=é')
    expect(new URLSearchParams(e.body).has('off')).toBe(false)
  })

  it('encodes formdata bodies as multipart with a boundary', async () => {
    const r = ok(
      await sendRequest(
        req({
          method: 'POST',
          url: `${base}/echo`,
          body: { mode: 'formdata', fields: [kv('field1', 'value one'), kv('field2', 'é'), kv('off', '1', false)] },
        }),
      ),
    )
    const e = echoOf(r)
    const contentType = String(e.headers['content-type'])
    expect(contentType).toMatch(/^multipart\/form-data; boundary=\S+$/)
    const boundary = contentType.split('boundary=')[1]
    expect(e.body).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="field1"\r\n\r\nvalue one\r\n`)
    expect(e.body).toContain('name="field2"\r\n\r\né\r\n')
    expect(e.body).not.toContain('name="off"')
    expect(e.body.endsWith(`--${boundary}--\r\n`)).toBe(true)
  })

  it('sends no body for mode none', async () => {
    const e = echoOf(ok(await sendRequest(req({ method: 'POST', url: `${base}/echo` }))))
    expect(e.body).toBe('')
  })
})

describe('redirects', () => {
  it('follows a 302 chain and reports the count and final URL', async () => {
    const r = ok(await sendRequest(req({ url: `${base}/hop?n=3` })))
    expect(r.status).toBe(200)
    expect(r.redirects).toBe(3)
    expect(r.finalUrl).toBe(`${base}/echo?done=1`)
  })

  it('returns too_many_redirects for a loop and respects maxRedirects', async () => {
    const loop = await sendRequest(req({ url: `${base}/loop` }), { maxRedirects: 5 })
    expect(loop.ok).toBe(false)
    if (!loop.ok) expect(loop.error.code).toBe('too_many_redirects')

    const limited = await sendRequest(req({ url: `${base}/hop?n=3` }), { maxRedirects: 2 })
    expect(limited.ok).toBe(false)
    if (!limited.ok) expect(limited.error.code).toBe('too_many_redirects')

    ok(await sendRequest(req({ url: `${base}/hop?n=3` }), { maxRedirects: 3 }))
  })

  const post = { mode: 'raw', language: 'text', content: 'payload' } as const

  it.each([301, 302, 303])('turns POST into GET without a body on %i', async (code) => {
    const r = ok(await sendRequest(req({ method: 'POST', url: `${base}/redir?code=${code}`, body: post })))
    const e = echoOf(r)
    expect(e.method).toBe('GET')
    expect(e.body).toBe('')
    expect(e.headers['content-type']).toBeUndefined()
    expect(e.headers['content-length']).toBeUndefined()
  })

  it.each([307, 308])('keeps method and body on %i', async (code) => {
    const r = ok(await sendRequest(req({ method: 'POST', url: `${base}/redir?code=${code}`, body: post })))
    const e = echoOf(r)
    expect(e.method).toBe('POST')
    expect(e.body).toBe('payload')
    expect(e.headers['content-type']).toBe('text/plain')
  })

  it('keeps HEAD as HEAD on 303 and turns PUT into GET', async () => {
    const head = ok(await sendRequest(req({ method: 'HEAD', url: `${base}/redir?code=303&to=/head` })))
    expect(head.finalUrl).toBe(`${base}/head`)
    expect(head.bodyBase64).toBe('')

    const put = echoOf(ok(await sendRequest(req({ method: 'PUT', url: `${base}/redir?code=303`, body: post }))))
    expect(put.method).toBe('GET')
  })

  it('refuses to follow redirects to non-http targets', async () => {
    const r = await sendRequest(req({ url: `${base}/redir?code=302&to=${encodeURIComponent('file:///etc/passwd')}` }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_url')
      expect(r.error.message).toMatch(/file:/)
    }
  })

  const secrets = [
    kv('Authorization', 'Bearer secret'),
    kv('Cookie', 'sid=1'),
    kv('Proxy-Authorization', 'Basic eHg6eHg='),
    kv('X-Keep', 'yes'),
  ]

  it('drops credentials when a redirect changes origin', async () => {
    const r = ok(
      await sendRequest(
        req({
          url: `${base}/redir?code=302&to=${encodeURIComponent(`${other}/echo`)}`,
          headers: secrets,
          auth: { type: 'apikey', key: 'X-Api-Key', value: 'k', in: 'header' },
        }),
      ),
    )
    expect(r.finalUrl).toBe(`${other}/echo`)
    const headers = echoOf(r).headers
    expect(headers['x-keep']).toBe('yes')
    expect(headers.authorization).toBeUndefined()
    expect(headers.cookie).toBeUndefined()
    expect(headers['proxy-authorization']).toBeUndefined()
    expect(headers['x-api-key']).toBeUndefined()
  })

  it('drops bearer auth on a cross-origin redirect', async () => {
    const r = ok(
      await sendRequest(
        req({
          url: `${base}/redir?code=307&to=${encodeURIComponent(`${other}/echo`)}`,
          auth: { type: 'bearer', token: 't' },
        }),
      ),
    )
    expect(echoOf(r).headers.authorization).toBeUndefined()
  })

  it('keeps credentials on same-origin redirects', async () => {
    const r = ok(
      await sendRequest(
        req({
          url: `${base}/redir?code=302&to=/echo`,
          headers: secrets,
          auth: { type: 'apikey', key: 'X-Api-Key', value: 'k', in: 'header' },
        }),
      ),
    )
    const headers = echoOf(r).headers
    expect(headers.authorization).toBe('Bearer secret')
    expect(headers.cookie).toBe('sid=1')
    expect(headers['proxy-authorization']).toBe('Basic eHg6eHg=')
    expect(headers['x-api-key']).toBe('k')
  })
})

describe('content decoding and size cap', () => {
  it.each(['gzip', 'deflate', 'br'])('decodes %s responses', async (enc) => {
    const r = ok(await sendRequest(req({ url: `${base}/${enc}` })))
    expect(text(r)).toBe(`${{ gzip: 'gzipped', deflate: 'deflated', br: 'brotli' }[enc]} hello`)
    expect(r.sizeBytes).toBe(text(r).length)
  })

  it('advertises supported encodings, unless the user set Accept-Encoding', async () => {
    const dflt = echoOf(ok(await sendRequest(req({ url: `${base}/echo` }))))
    expect(dflt.headers['accept-encoding']).toBe('gzip, deflate, br')

    const own = echoOf(
      ok(await sendRequest(req({ url: `${base}/echo`, headers: [kv('Accept-Encoding', 'identity')] }))),
    )
    expect(own.headers['accept-encoding']).toBe('identity')
  })

  it('returns raw bytes undecoded when the user set Accept-Encoding', async () => {
    const r = ok(await sendRequest(req({ url: `${base}/gzip`, headers: [kv('Accept-Encoding', 'gzip')] })))
    const raw = Buffer.from(r.bodyBase64, 'base64')
    expect(raw[0]).toBe(0x1f)
    expect(zlib.gunzipSync(raw).toString()).toBe('gzipped hello')
  })

  it('cuts a gzip bomb at the cap on decoded bytes', async () => {
    const r = ok(await sendRequest(req({ url: `${base}/bomb` }), { maxBodyBytes: MIB }))
    expect(r.bodyTruncated).toBe(true)
    expect(Buffer.from(r.bodyBase64, 'base64').length).toBe(MIB)
    // Content-Length (compressed size) is not the decoded size; the bytes actually read are reported
    expect(r.sizeBytes).toBeGreaterThanOrEqual(MIB)
  })

  it('truncates a 30 MiB response at a 1 MiB cap', async () => {
    const r = ok(await sendRequest(req({ url: `${base}/big` }), { maxBodyBytes: MIB }))
    expect(r.bodyTruncated).toBe(true)
    expect(Buffer.from(r.bodyBase64, 'base64').length).toBeLessThanOrEqual(MIB)
    expect(r.sizeBytes).toBe(30 * MIB)
  })

  it('reports bytes read when truncating a response without Content-Length', async () => {
    const r = ok(await sendRequest(req({ url: `${base}/bigchunked` }), { maxBodyBytes: MIB }))
    expect(r.bodyTruncated).toBe(true)
    expect(Buffer.from(r.bodyBase64, 'base64').length).toBe(MIB)
    expect(r.sizeBytes).toBeGreaterThanOrEqual(MIB)
    expect(r.sizeBytes).toBeLessThan(30 * MIB)
  })

  it('does not flag a body that fits exactly in the cap', async () => {
    const r = ok(await sendRequest(req({ url: `${base}/json` }), { maxBodyBytes: 17 }))
    expect(r.bodyTruncated).toBe(false)
    expect(r.sizeBytes).toBe(17)
  })

  it('round-trips non-UTF-8 bytes exactly', async () => {
    const r = ok(await sendRequest(req({ url: `${base}/bytes` })))
    expect([...Buffer.from(r.bodyBase64, 'base64')]).toEqual([0xff, 0xfe, 0x00, 0x80])
  })

  it('returns an empty body for HEAD, 204 and keeps Content-Length of HEAD out of sizeBytes', async () => {
    const head = ok(await sendRequest(req({ method: 'HEAD', url: `${base}/head` })))
    expect(head.status).toBe(200)
    expect(head.bodyBase64).toBe('')
    expect(head.sizeBytes).toBe(0)

    const none = ok(await sendRequest(req({ url: `${base}/204` })))
    expect(none.status).toBe(204)
    expect(none.statusText).toBe('No Content')
    expect(none.bodyBase64).toBe('')
  })
})

describe('headers and cookies', () => {
  it('keeps duplicate headers as separate entries and parses every set-cookie', async () => {
    const r = ok(await sendRequest(req({ url: `${base}/cookies` })))
    const setCookies = r.headers.filter(([n]) => n.toLowerCase() === 'set-cookie')
    expect(setCookies).toEqual([
      ['set-cookie', 'a=1; Path=/; HttpOnly'],
      ['set-cookie', 'b=2; Max-Age=60'],
    ])
    expect(r.headers.filter(([n]) => n === 'x-dup')).toEqual([
      ['x-dup', 'one'],
      ['x-dup', 'two'],
    ])
    expect(r.cookies).toEqual([
      { name: 'a', value: '1', attributes: { Path: '/', HttpOnly: true } },
      { name: 'b', value: '2', attributes: { 'Max-Age': '60' } },
    ])
  })

  it('parseSetCookie handles values with equals signs, empty values and attribute casing', () => {
    expect(parseSetCookie('t=a=b==; Secure; SameSite=Lax; domain=example.com')).toEqual({
      name: 't',
      value: 'a=b==',
      attributes: { Secure: true, SameSite: 'Lax', domain: 'example.com' },
    })
    expect(parseSetCookie('empty=')).toEqual({ name: 'empty', value: '', attributes: {} })
    expect(parseSetCookie('  spaced = v ; Path = /x ')).toEqual({
      name: 'spaced',
      value: 'v',
      attributes: { Path: '/x' },
    })
  })
})

describe('failures', () => {
  it('maps an unknown host to dns_failed', async () => {
    const r = await sendRequest(req({ url: 'http://nonexistent.invalid/' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('dns_failed')
  })

  it('maps a closed port to connection_refused', async () => {
    const probe = http.createServer()
    const port = await listen(probe)
    await close(probe)
    const r = await sendRequest(req({ url: `http://127.0.0.1:${port}/` }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('connection_refused')
  })

  it('maps a self-signed certificate to tls_error with the reason, never skipping verification', async () => {
    const r = await sendRequest(req({ url: tlsBase }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('tls_error')
      expect(r.error.message).toMatch(/self[- ]signed|SELF_SIGNED/i)
    }
  })

  it('times out when the server never answers', async () => {
    const started = performance.now()
    const r = await sendRequest(req({ url: `${base}/hang` }), { timeoutMs: 100 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('timeout')
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('applies the timeout to body reading as well', async () => {
    const r = await sendRequest(req({ url: `${base}/slowbody` }), { timeoutMs: 150 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('timeout')
  })

  it('uses a single deadline across redirects', async () => {
    // each hop is fast; the budget must still be shared, so a tiny budget cannot be restarted per hop
    const r = await sendRequest(req({ url: `${base}/hop?n=5` }), { timeoutMs: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('timeout')
  })

  it('returns cancelled when the signal aborts and removes its listener', async () => {
    const controller = new AbortController()
    const pending = sendRequest(req({ url: `${base}/hang` }), { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('cancelled')
  })

  it('returns cancelled when the signal is already aborted', async () => {
    const r = await sendRequest(req({ url: `${base}/json` }), { signal: AbortSignal.abort() })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('cancelled')
  })

  it('does not leak abort listeners on a shared signal', async () => {
    const controller = new AbortController()
    let added = 0
    let removed = 0
    const add = controller.signal.addEventListener.bind(controller.signal)
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      if (args[0] === 'abort') added++
      return add(...args)
    }) as typeof add
    controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      if (args[0] === 'abort') removed++
      return remove(...args)
    }) as typeof remove
    ok(await sendRequest(req({ url: `${base}/json` }), { signal: controller.signal }))
    expect(added).toBeGreaterThan(0)
    expect(removed).toBe(added)
  })
})
