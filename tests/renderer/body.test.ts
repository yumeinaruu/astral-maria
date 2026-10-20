import { describe, expect, it, vi } from 'vitest'
import {
  decodeBody,
  formatBytes,
  formatDuration,
  LARGE_TEXT_CHARS,
  prettyJson,
  suggestFileName,
} from '../../src/renderer/src/lib/body'
import type { HttpResponse } from '../../src/shared/types'

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function response(body: string | Uint8Array, contentType?: string, extra: Partial<HttpResponse> = {}): HttpResponse {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return {
    status: 200,
    statusText: 'OK',
    headers: contentType === undefined ? [] : [['Content-Type', contentType]],
    bodyBase64: toBase64(bytes),
    bodyTruncated: false,
    sizeBytes: bytes.length,
    totalMs: 12,
    finalUrl: 'https://example.com/',
    redirects: 0,
    cookies: [],
    ...extra,
  }
}

describe('decodeBody', () => {
  it('detects JSON from the content type', () => {
    const d = decodeBody(response('{"a":1,"b":[1,2]}', 'application/json; charset=utf-8'))
    expect(d.kind).toBe('json')
    expect(d.text).toBe('{"a":1,"b":[1,2]}')
    expect(prettyJson(d.text ?? '')).toContain('\n  "a": 1')
  })

  it('treats +json media types as JSON', () => {
    expect(decodeBody(response('{}', 'application/problem+json')).kind).toBe('json')
  })

  it('detects xml and html', () => {
    expect(decodeBody(response('<a/>', 'application/xml')).kind).toBe('xml')
    expect(decodeBody(response('<a/>', 'text/xml')).kind).toBe('xml')
    expect(decodeBody(response('<p>x</p>', 'text/html; charset=utf-8')).kind).toBe('html')
    expect(decodeBody(response('hello', 'text/plain')).kind).toBe('text')
  })

  it('previews known image types through a data URL', () => {
    const d = decodeBody(response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png'))
    expect(d.kind).toBe('image')
    expect(d.dataUrl?.startsWith('data:image/png;base64,')).toBe(true)
    expect(d.text).toBeUndefined()
  })

  it('previews svg as an image, not as xml', () => {
    const d = decodeBody(response('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'))
    expect(d.kind).toBe('image')
    expect(d.dataUrl?.startsWith('data:image/svg+xml;base64,')).toBe(true)
  })

  it('treats other image types as binary', () => {
    expect(decodeBody(response(new Uint8Array([1, 2]), 'image/tiff')).kind).toBe('binary')
  })

  it('reports invalid UTF-8 as binary without text', () => {
    const d = decodeBody(response(new Uint8Array([0xff, 0xfe, 0x00]), 'application/octet-stream'))
    expect(d.kind).toBe('binary')
    expect(d.text).toBeUndefined()
  })

  it('reports invalid UTF-8 labelled as text as binary', () => {
    expect(decodeBody(response(new Uint8Array([0xc3, 0x28]), 'text/plain')).kind).toBe('binary')
  })

  it('falls back to raw text when JSON labelled application/json is invalid', () => {
    const d = decodeBody(response('{"a":', 'application/json'))
    expect(d.text).toBe('{"a":')
    expect(prettyJson(d.text ?? '')).toBe('{"a":')
  })

  it('sniffs the kind when the content type is missing or generic', () => {
    expect(decodeBody(response('{"a":1}')).kind).toBe('json')
    expect(decodeBody(response('[1]', 'application/octet-stream')).kind).toBe('json')
    expect(decodeBody(response('<!DOCTYPE html><html></html>')).kind).toBe('html')
    expect(decodeBody(response('<?xml version="1.0"?><a/>')).kind).toBe('xml')
    expect(decodeBody(response('plain words')).kind).toBe('text')
    expect(decodeBody(response('not json {', 'application/octet-stream')).kind).toBe('text')
  })

  it('sniffs images by their magic bytes', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
    expect(decodeBody(response(png, 'application/octet-stream')).kind).toBe('image')
    expect(decodeBody(response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).dataUrl).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('treats bytes with NUL as binary when sniffing', () => {
    expect(decodeBody(response(new Uint8Array([0x61, 0x00, 0x62]))).kind).toBe('binary')
  })

  it('strips a UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')])
    const d = decodeBody(response(bytes, 'application/json'))
    expect(d.text).toBe('{"a":1}')
  })

  it('respects the charset of the content type', () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9])
    expect(decodeBody(response(latin1, 'text/plain; charset=iso-8859-1')).text).toBe('café')
    expect(decodeBody(response('café', 'text/plain; charset="utf-8"')).text).toBe('café')
  })

  it('falls back to UTF-8 for an unknown charset', () => {
    expect(decodeBody(response('abc', 'text/plain; charset=nonsense')).text).toBe('abc')
  })

  it('marks a text over 2 MiB as large', () => {
    const big = 'a'.repeat(3 * 1024 * 1024)
    const d = decodeBody(response(big, 'text/plain'))
    expect(d.large).toBe(true)
    expect(d.text?.length).toBe(big.length)
    expect(LARGE_TEXT_CHARS).toBe(2 * 1024 * 1024)
    expect(decodeBody(response('small', 'text/plain')).large).toBe(false)
  })

  it('never throws on empty bodies or garbage content types', () => {
    expect(() => decodeBody(response('', 'application/json'))).not.toThrow()
    expect(decodeBody(response('', 'application/json')).text).toBe('')
    expect(decodeBody(response('')).text).toBe('')
    for (const ct of [';;;', '=', 'text/', '/json', 'charset=', '\u0000', 'a'.repeat(5000)]) {
      expect(() => decodeBody(response('x', ct))).not.toThrow()
    }
    expect(() => decodeBody(response('x', 'text/plain; charset=')).text).not.toThrow()
    expect(() => decodeBody({ ...response('x'), bodyBase64: '!!not base64!!' })).not.toThrow()
  })
})

describe('truncated bodies', () => {
  it('decodes text cut in the middle of a multibyte character', () => {
    for (const sample of ['привет мир', 'ok 😀😀']) {
      const full = new TextEncoder().encode(sample)
      for (let cut = full.length - 1; cut > full.length - 4; cut--) {
        const d = decodeBody(response(full.slice(0, cut), 'application/json', { bodyTruncated: true }))
        expect(d.kind).toBe('json')
        expect(d.text).toBeDefined()
        expect(sample.startsWith(d.text!)).toBe(true)
      }
    }
  })

  it('still reports genuinely binary truncated bodies as binary', () => {
    const d = decodeBody(
      response(new Uint8Array([0xff, 0xfe, 0x00, 0xc3]), 'application/octet-stream', { bodyTruncated: true }),
    )
    expect(d.kind).toBe('binary')
    expect(d.text).toBeUndefined()
  })

  it('does not forgive an incomplete character in a body that was not truncated', () => {
    const bytes = new TextEncoder().encode('привет').slice(0, 5)
    expect(decodeBody(response(bytes, 'text/plain')).kind).toBe('binary')
  })
})

describe('large bodies', () => {
  it('never parses a huge sniffed body as JSON', () => {
    const big = '{"a":"' + 'x'.repeat(3 * 1024 * 1024) + '"}'
    const parse = vi.spyOn(JSON, 'parse')
    const d = decodeBody(response(big))
    const longest = Math.max(0, ...parse.mock.calls.map(([t]) => String(t).length))
    parse.mockRestore()
    expect(d.large).toBe(true)
    expect(longest).toBeLessThan(10_000)
  })
})

describe('prettyJson', () => {
  it('indents valid JSON and leaves everything else unchanged', () => {
    expect(prettyJson('{"a":[1]}')).toBe('{\n  "a": [\n    1\n  ]\n}')
    expect(prettyJson('nope')).toBe('nope')
    expect(prettyJson('')).toBe('')
  })
})

describe('formatBytes', () => {
  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1048576)).toBe('1 MB')
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5 GB')
  })
})

describe('formatDuration', () => {
  it('uses ms below a second and seconds above', () => {
    expect(formatDuration(12.4)).toBe('12 ms')
    expect(formatDuration(1500)).toBe('1.50 s')
  })
})

describe('suggestFileName', () => {
  it('prefers Content-Disposition', () => {
    const r = response('x', 'text/plain', { headers: [['Content-Disposition', 'attachment; filename="report.csv"']] })
    expect(suggestFileName(r)).toBe('report.csv')
  })

  it('understands filename* and strips directories', () => {
    const r = response('x', 'text/plain', {
      headers: [['content-disposition', "attachment; filename*=UTF-8''..%2Fna%C3%AFve.txt"]],
    })
    expect(suggestFileName(r)).toBe('naïve.txt')
  })

  it('falls back to response.<ext> by content type', () => {
    expect(suggestFileName(response('{}', 'application/json'))).toBe('response.json')
    expect(suggestFileName(response('x', 'image/png'))).toBe('response.png')
    expect(suggestFileName(response('x', 'text/html'))).toBe('response.html')
    expect(suggestFileName(response('x', 'application/octet-stream'))).toBe('response.bin')
    expect(suggestFileName(response('x'))).toBe('response.bin')
  })
})
