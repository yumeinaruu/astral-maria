import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Agent } from 'undici'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DispatchError, requestUrl, toDispatch } from '../../src/main/http/dispatchOptions'
import { sendRequest } from '../../src/main/http/sendRequest'
import type { RequestItem } from '../../src/shared/types'

function req(over: Partial<RequestItem> = {}): RequestItem {
  return {
    id: 'r',
    name: 'r',
    method: 'GET',
    url: 'http://example.test/base',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...over,
  }
}

const kv = (key: string, value: string, enabled = true) => ({ key, value, enabled })

describe('toDispatch', () => {
  it('splits the URL into origin and path, query and query auth included', () => {
    const spec = toDispatch(
      req({
        url: 'https://example.test:8443/a/b?x=1',
        params: [kv('q', 'a b'), kv('off', '1', false)],
        auth: { type: 'apikey', key: 'key', value: 'v&', in: 'query' },
      }),
    )
    expect(spec.origin).toBe('https://example.test:8443')
    expect(spec.path).toBe('/a/b?x=1&q=a%20b&key=v%26')
    expect(spec.method).toBe('GET')
    expect(spec.body).toBeUndefined()
    expect('body' in spec).toBe(false)
  })

  it('builds the headers: enabled rows merged by name, Accept-Encoding, auth and the default content type', () => {
    const spec = toDispatch(
      req({
        method: 'POST',
        headers: [kv('X-A', '1'), kv('x-a', '2'), kv('Off', '1', false), kv('Cookie', 'a=1'), kv('cookie', 'b=2')],
        body: { mode: 'raw', language: 'xml', content: '<a/>' },
        auth: { type: 'basic', username: 'u', password: 'p' },
      }),
    )
    expect(spec.headers).toEqual({
      'x-a': '1, 2',
      cookie: 'a=1; b=2',
      'accept-encoding': 'gzip, deflate, br',
      authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
      'content-type': 'application/xml',
    })
    expect(spec.body).toBe('<a/>')
  })

  it('keeps a user-set Authorization, Accept-Encoding and Content-Type', () => {
    const spec = toDispatch(
      req({
        method: 'POST',
        headers: [kv('Authorization', 'mine'), kv('Accept-Encoding', 'identity'), kv('Content-Type', 'text/x')],
        body: { mode: 'urlencoded', fields: [kv('a', 'x y'), kv('b', 'é')] },
        auth: { type: 'bearer', token: 't' },
      }),
    )
    expect(spec.headers).toEqual({ authorization: 'mine', 'accept-encoding': 'identity', 'content-type': 'text/x' })
    expect(spec.body).toBe('a=x%20y&b=%C3%A9')
  })

  it('builds multipart bodies whose boundary matches the header, and sends no body with HEAD', () => {
    const spec = toDispatch(req({ method: 'POST', body: { mode: 'formdata', fields: [kv('f', 'v')] } }))
    const boundary = /boundary=(\S+)$/.exec(String(spec.headers['content-type']))![1]
    expect(Buffer.isBuffer(spec.body)).toBe(true)
    expect(String(spec.body)).toBe(
      `--${boundary}\r\nContent-Disposition: form-data; name="f"\r\n\r\nv\r\n--${boundary}--\r\n`,
    )
    const head = toDispatch(req({ method: 'HEAD', body: { mode: 'raw', language: 'text', content: 'x' } }))
    expect(head.body).toBeUndefined()
    expect(head.headers['content-type']).toBe('text/plain')
  })

  it('throws invalid_url without the query, and requestUrl falls back to the raw URL', () => {
    const bad = () => toDispatch(req({ url: 'not a url?secret=1' }))
    expect(bad).toThrow(DispatchError)
    expect(bad).toThrow('Invalid URL: not a url?…')
    expect(() => toDispatch(req({ url: 'file:///x' }))).toThrow(/Unsupported URL scheme file:/)
    expect(requestUrl(req({ url: 'nope' }))).toBe('nope')
    expect(requestUrl(req({ params: [kv('a', '1')] }))).toBe('http://example.test/base?a=1')
  })
})

describe('toDispatch parity with sendRequest', () => {
  let server: Server
  let base: string
  let seen: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] = []
  const agent = new Agent()

  beforeAll(async () => {
    server = createServer((r, res) => {
      const chunks: Buffer[] = []
      r.on('data', (c: Buffer) => chunks.push(c))
      r.on('end', () => {
        seen.push({ method: r.method!, url: r.url!, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') })
        res.end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await agent.close()
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  })

  const bodies: RequestItem['body'][] = [
    { mode: 'none' },
    { mode: 'raw', language: 'json', content: '{"a":1}' },
    { mode: 'urlencoded', fields: [kv('a', 'x y')] },
    { mode: 'formdata', fields: [kv('f', 'one'), kv('g', 'é')] },
  ]

  for (const body of bodies) {
    it(`dispatches the same request as sendRequest (${body.mode})`, async () => {
      const r = req({
        method: body.mode === 'none' ? 'GET' : 'POST',
        url: `${base}/p`,
        params: [kv('q', '1')],
        headers: [kv('X-Test', 'yes')],
        body,
        auth: { type: 'apikey', key: 'X-Key', value: 'k', in: 'header' },
      })
      seen = []
      expect((await sendRequest(r)).ok).toBe(true)
      const res = await agent.request(toDispatch(r))
      await res.body.dump()
      expect(seen).toHaveLength(2)
      const [viaSend, viaDispatch] = seen
      const boundary = /boundary=(\S+)/.exec(String(viaDispatch.headers['content-type']))?.[1]
      const sendBoundary = /boundary=(\S+)/.exec(String(viaSend.headers['content-type']))?.[1]
      const same = (s: string) => (boundary && sendBoundary ? s.split(sendBoundary).join(boundary) : s)
      expect(viaDispatch.method).toBe(viaSend.method)
      expect(viaDispatch.url).toBe(viaSend.url)
      expect(viaDispatch.body).toBe(same(viaSend.body))
      const { connection: _a, ...dispatchHeaders } = viaDispatch.headers
      const { connection: _b, ...sendHeaders } = viaSend.headers
      expect(dispatchHeaders).toEqual(JSON.parse(same(JSON.stringify(sendHeaders))))
    })
  }
})
