import { describe, expect, it } from 'vitest'
import { looksLikeCurl, parseCurl, shellWords } from '../../src/shared/curl'

describe('shellWords', () => {
  it('handles quotes, escapes and line continuations', () => {
    expect(shellWords(`curl 'a b' "c \\"d\\" $x" e\\ f \\\n  g`)).toEqual(['curl', 'a b', 'c "d" $x', 'e f', 'g'])
  })

  it("decodes $'…' quotes and joins adjacent quoted parts", () => {
    expect(shellWords(`$'line\\nnext\\x41' it'"s'`)).toEqual(['line\nnextA', 'it"s'])
  })

  it('accepts Windows cmd ^ continuations and CRLF backslash continuations', () => {
    expect(shellWords('curl ^\r\n  -I x')).toEqual(['curl', '-I', 'x'])
    expect(shellWords('curl \\\r\n  x')).toEqual(['curl', 'x'])
  })

  it('throws on an unterminated quote', () => {
    expect(() => shellWords(`curl 'abc`)).toThrow('Unterminated quote')
  })
})

describe('looksLikeCurl', () => {
  it('recognises a curl command, with or without a prompt', () => {
    expect(looksLikeCurl('curl https://x')).toBe(true)
    expect(looksLikeCurl('  $ curl -I x')).toBe(true)
    expect(looksLikeCurl('https://curl.se')).toBe(false)
    expect(looksLikeCurl('curly')).toBe(false)
  })
})

describe('parseCurl', () => {
  it('reads a GET with headers and a query', () => {
    const r = parseCurl(`curl -sSL 'https://api.example.com/users?page=2&q=a%20b' -H 'Accept: application/json'`)
    expect(r).toEqual({
      method: 'GET',
      url: 'https://api.example.com/users?page=2&q=a%20b',
      headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
      body: { mode: 'none' },
      auth: { type: 'none' },
      skipped: [],
    })
  })

  it('reads a JSON body as raw JSON and implies POST', () => {
    const r = parseCurl(`curl https://x.io/a -H 'Content-Type: application/json' --data-raw '{"a":1}'`)
    expect(r.method).toBe('POST')
    expect(r.body).toEqual({ mode: 'raw', language: 'json', content: '{"a":1}' })
    // The raw language sends this type; the redundant header is dropped.
    expect(r.headers).toEqual([])
  })

  it('recognises JSON without a content type, and keeps a type it does not imply', () => {
    expect(parseCurl(`curl x -d '[1,2]'`).body).toEqual({ mode: 'raw', language: 'json', content: '[1,2]' })
    const r = parseCurl(`curl x -H 'content-type: application/vnd.api+json' -d '{}'`)
    expect(r.body).toEqual({ mode: 'raw', language: 'json', content: '{}' })
    expect(r.headers).toEqual([{ key: 'content-type', value: 'application/vnd.api+json', enabled: true }])
  })

  it('reads -d pairs as a urlencoded body, joining several -d with &', () => {
    const r = parseCurl(`curl -X PUT http://x -d 'a=1' -d 'b=two+words%21' --data-urlencode 'c=x&y'`)
    expect(r.method).toBe('PUT')
    expect(r.body).toEqual({
      mode: 'urlencoded',
      fields: [
        { key: 'a', value: '1', enabled: true },
        { key: 'b', value: 'two words!', enabled: true },
        { key: 'c', value: 'x&y', enabled: true },
      ],
    })
  })

  it('reads text that is not pairs as raw text', () => {
    expect(parseCurl(`curl x --data 'hello world'`).body).toEqual({
      mode: 'raw',
      language: 'text',
      content: 'hello world',
    })
  })

  it('reads form fields, skipping file uploads, and drops a copied multipart boundary', () => {
    const r = parseCurl(
      `curl x -H 'Content-Type: multipart/form-data; boundary=abc' -F 'name=Ann' -F 'pic=@me.png' --form-string 'raw=@x'`,
    )
    expect(r.body).toEqual({
      mode: 'formdata',
      fields: [
        { key: 'name', value: 'Ann', enabled: true },
        { key: 'raw', value: '@x', enabled: true },
      ],
    })
    expect(r.headers).toEqual([])
    expect(r.skipped).toEqual(['file field pic'])
  })

  it('reads -u as basic auth', () => {
    expect(parseCurl('curl -u ann:p:w x').auth).toEqual({ type: 'basic', username: 'ann', password: 'p:w' })
    expect(parseCurl('curl --user ann x').auth).toEqual({ type: 'basic', username: 'ann', password: '' })
  })

  it('moves the data into the query with -G, and reads -I as HEAD', () => {
    const r = parseCurl(`curl -G 'http://x/s?a=1' -d q=cats`)
    expect(r).toMatchObject({ method: 'GET', url: 'http://x/s?a=1&q=cats', body: { mode: 'none' } })
    expect(parseCurl('curl -I http://x').method).toBe('HEAD')
  })

  it('reads glued short options, --opt=value, cookies, user agent and referer', () => {
    const r = parseCurl(`curl -XDELETE --url=http://x -b 'a=1; b=2' -A ua/1 -e http://ref -H'X-A: b'`)
    expect(r.method).toBe('DELETE')
    expect(r.url).toBe('http://x')
    expect(r.headers.map((h) => [h.key, h.value])).toEqual([
      ['Cookie', 'a=1; b=2'],
      ['User-Agent', 'ua/1'],
      ['Referer', 'http://ref'],
      ['X-A', 'b'],
    ])
  })

  it('skips the values of options that do not change the request', () => {
    const r = parseCurl('curl -o out.json --max-time 5 -w "%{http_code}" --compressed -k http://x/real')
    expect(r.url).toBe('http://x/real')
  })

  it('adds http:// to a URL without a scheme and keeps a {{variable}} URL as it is', () => {
    expect(parseCurl('curl localhost:3000/a').url).toBe('http://localhost:3000/a')
    expect(parseCurl("curl '{{base}}/a'").url).toBe('{{base}}/a')
  })

  it('sends --json as JSON', () => {
    const r = parseCurl(`curl --json '{"a":1}' http://x`)
    expect(r.method).toBe('POST')
    expect(r.body).toEqual({ mode: 'raw', language: 'json', content: '{"a":1}' })
    expect(r.headers.map((h) => h.key)).toEqual(['Content-Type', 'Accept'])
  })

  it('skips file data', () => {
    const r = parseCurl('curl -d @body.json http://x')
    expect(r.body).toEqual({ mode: 'none' })
    expect(r.skipped).toEqual(['file data @body.json'])
  })

  it('rejects what is not a usable curl command', () => {
    expect(() => parseCurl('wget http://x')).toThrow('Not a curl command')
    expect(() => parseCurl('curl -s')).toThrow('no URL')
    expect(() => parseCurl('curl -X BREW http://x')).toThrow('Unsupported method BREW')
  })
})
