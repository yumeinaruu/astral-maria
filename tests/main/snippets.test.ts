import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import { sendRequest } from '../../src/main/http/sendRequest'
import { snippet } from '../../src/main/http/snippets'
import { parseCurl } from '../../src/shared/curl'
import type { RequestItem } from '../../src/shared/types'

const run = promisify(execFile)

function req(overrides: Partial<RequestItem> = {}): RequestItem {
  return {
    id: 'r1',
    name: 'r',
    method: 'GET',
    url: 'http://localhost/',
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

let server: http.Server
let base: string
let last: Echo
beforeAll(async () => {
  server = http.createServer(async (r, res) => {
    const chunks: Buffer[] = []
    for await (const c of r) chunks.push(c as Buffer)
    last = { method: r.method!, url: r.url!, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }
    res.end('ok')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((done) => server.close(() => done())))

/** What the server received from Send, and from running the snippet. */
async function viaSend(request: RequestItem): Promise<Echo> {
  const result = await sendRequest(request)
  expect(result.ok).toBe(true)
  return last
}

async function viaCurl(request: RequestItem): Promise<Echo> {
  await run('/bin/sh', ['-c', snippet(request, 'curl')])
  return last
}

async function viaFetch(request: RequestItem): Promise<Echo> {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  await new AsyncFunction('console', snippet(request, 'fetch'))({ log: () => {} })
  return last
}

/** The parts of a request every client sends alike (user agent, encoding and connection headers differ). */
function essence(e: Echo, options: { form?: boolean } = {}) {
  const pick = ['authorization', 'x-api-key', 'x-custom', 'cookie']
  const headers = Object.fromEntries(pick.filter((h) => e.headers[h] !== undefined).map((h) => [h, e.headers[h]]))
  const type = String(e.headers['content-type'] ?? '')
  // A multipart body differs only in its boundary, a urlencoded one in how a space is written; compare their fields.
  const body = options.form
    ? [...e.body.matchAll(/name="([^"]*)"\r\n\r\n([^\r]*)/g)].map((m) => [m[1], m[2]])
    : type.startsWith('application/x-www-form-urlencoded')
      ? [...new URLSearchParams(e.body)]
      : e.body
  return { method: e.method, url: e.url, headers, type: options.form ? type.split(';')[0] : type, body }
}

const CASES: [string, Partial<RequestItem>, { form?: boolean }?][] = [
  [
    'a GET with a query and headers',
    { params: [kv('q', 'a b&c'), kv('off', '1', false)], headers: [kv('X-Custom', "it's")] },
  ],
  [
    'a JSON POST with bearer auth',
    {
      method: 'POST',
      body: { mode: 'raw', language: 'json', content: '{"name":"Ann \'O\'","emoji":"✓"}' },
      auth: { type: 'bearer', token: 'tok$en' },
    },
  ],
  [
    'a urlencoded PUT with basic auth',
    {
      method: 'PUT',
      body: { mode: 'urlencoded', fields: [kv('a b', '1&2'), kv('c', 'ü=')] },
      auth: { type: 'basic', username: 'ann', password: 'p:w' },
    },
  ],
  [
    'a form-data POST',
    { method: 'POST', body: { mode: 'formdata', fields: [kv('name', 'Ann'), kv('at', '@file')] } },
    { form: true },
  ],
  [
    'an API key in the query and a DELETE',
    { method: 'DELETE', auth: { type: 'apikey', key: 'k', value: 'v/1', in: 'query' } },
  ],
  [
    'an API key header and a text body on PATCH',
    {
      method: 'PATCH',
      headers: [kv('Content-Type', 'text/csv')],
      body: { mode: 'raw', language: 'text', content: 'line1\nline2 "q"' },
      auth: { type: 'apikey', key: 'X-Api-Key', value: 'secret', in: 'header' },
    },
  ],
]

describe('snippets send what Send sends', () => {
  for (const [name, overrides, options] of CASES) {
    it(`curl: ${name}`, async () => {
      const request = req({ url: `${base}/path/x`, ...overrides })
      expect(essence(await viaCurl(request), options)).toEqual(essence(await viaSend(request), options))
    })
    it(`fetch: ${name}`, async () => {
      const request = req({ url: `${base}/path/x`, ...overrides })
      expect(essence(await viaFetch(request), options)).toEqual(essence(await viaSend(request), options))
    })
  }

  it('curl: a HEAD request', async () => {
    const request = req({ url: `${base}/h`, method: 'HEAD' })
    expect(snippet(request, 'curl')).toContain('--head')
    expect((await viaCurl(request)).method).toBe('HEAD')
  })
})

describe('curl snippets parse back to the same request', () => {
  for (const [name, overrides] of CASES) {
    it(name, () => {
      const request = req({ url: 'https://api.example.com/v1', ...overrides })
      const parsed = parseCurl(snippet(request, 'curl'))
      const sent = parseCurl(snippet({ ...request, ...parsed, params: [], auth: parsed.auth }, 'curl'))
      expect(sent).toEqual(parsed)
      expect(parsed.method).toBe(request.method)
      if (request.body.mode !== 'none') expect(parsed.body.mode).toBe(request.body.mode)
    })
  }
})

describe('snippet text', () => {
  it('shows a GET without a method or options', () => {
    expect(snippet(req(), 'curl')).toBe("curl --location 'http://localhost/'\n")
    expect(snippet(req(), 'fetch')).toBe(
      'const response = await fetch("http://localhost/")\nconsole.log(response.status, await response.text())\n',
    )
  })

  it('keeps an unknown {{variable}} URL and still appends the query', () => {
    const text = snippet(req({ url: '{{base}}/a', params: [kv('x', '1 2')] }), 'curl')
    expect(text).toContain("'{{base}}/a?x=1%202'")
  })

  it('writes Python that parses', () => {
    for (const [, overrides] of CASES) {
      const code = snippet(req(overrides), 'python')
      expect(code.startsWith('import requests\n')).toBe(true)
      execFileSync('python3', ['-I', '-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: code })
    }
  })

  it('writes Python with form fields as multipart and a raw body as UTF-8', () => {
    const form = snippet(req({ method: 'POST', body: { mode: 'formdata', fields: [kv('a', '1')] } }), 'python')
    expect(form).toContain('files = [\n    ("a", (None, "1")),\n]')
    const raw = snippet(req({ method: 'POST', body: { mode: 'raw', language: 'json', content: '{}' } }), 'python')
    expect(raw).toContain('payload = "{}"')
    expect(raw).toContain('response = requests.request("POST", url, headers=headers, data=payload.encode("utf-8"))')
  })

  it('rejects an unknown language', () => {
    expect(() => snippet(req(), 'ruby' as never)).toThrow('unknown_language: ruby')
    expect(() => snippet(req(), '__proto__' as never)).toThrow('unknown_language')
  })
})
