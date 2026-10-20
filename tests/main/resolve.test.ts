import { describe, expect, it } from 'vitest'
import { resolveRequest, resolveText } from '../../src/main/http/resolve'
import type { RequestItem } from '../../src/shared/types'

describe('resolveText', () => {
  it('replaces from the first scope that has the variable', () => {
    expect(resolveText('{{a}}', [{ b: '1' }, { a: 'x' }])).toBe('x')
  })
  it('lets the earlier scope win', () => {
    expect(resolveText('{{a}}', [{ a: 'first' }, { a: 'second' }])).toBe('first')
  })
  it('keeps unknown variables literally', () => {
    expect(resolveText('{{nope}}', [{ a: '1' }])).toBe('{{nope}}')
  })
  it('resolves names padded with spaces', () => {
    expect(resolveText('{{ a }}', [{ a: 'x' }])).toBe('x')
  })
  it('supports dots and dashes in names', () => {
    expect(resolveText('{{base.url}}/{{x-y}}', [{ 'base.url': 'h', 'x-y': 'z' }])).toBe('h/z')
  })
  it('does not expand replacement values again', () => {
    expect(resolveText('{{a}}', [{ a: '{{b}}', b: 'x' }])).toBe('{{b}}')
    expect(resolveText('{{a}}', [{ a: '{{a}}' }])).toBe('{{a}}')
  })
  it('leaves JSON braces untouched', () => {
    expect(resolveText('{"a":{"b":1}}', [{ a: 'x', b: 'y' }])).toBe('{"a":{"b":1}}')
  })
  it('handles triple braces', () => {
    expect(resolveText('{{{x}}}', [{ x: 'v' }])).toBe('{v}')
  })
  it('does not resolve Object.prototype members', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(resolveText(`{{${name}}}`, [{}])).toBe(`{{${name}}}`)
    }
  })
  it('resolves an own property named constructor', () => {
    expect(resolveText('{{constructor}}', [{ constructor: 'ok' }])).toBe('ok')
  })
})

const base = (): RequestItem => ({
  id: 'r1',
  name: 'Req {{a}}',
  method: 'POST',
  url: '{{host}}/items',
  params: [
    { key: '{{pk}}', value: '{{pv}}', enabled: true },
    { key: 'off', value: '{{pv}}', enabled: false },
  ],
  headers: [
    { key: 'X-{{pk}}', value: 'Bearer {{pv}}', enabled: true },
    { key: 'X-Off', value: '{{pv}}', enabled: false },
  ],
  body: { mode: 'raw', language: 'json', content: '{"v":"{{pv}}"}' },
  auth: { type: 'bearer', token: '{{tok}}' },
})
const scope = { host: 'https://h', pk: 'k', pv: 'v', tok: 'T', user: 'u', pass: 'p', a: 'A' }

describe('resolveRequest', () => {
  it('resolves url, params, headers, raw body and bearer token', () => {
    const r = resolveRequest(base(), [scope])
    expect(r.url).toBe('https://h/items')
    expect(r.params[0]).toEqual({ key: 'k', value: 'v', enabled: true })
    expect(r.headers[0]).toEqual({ key: 'X-k', value: 'Bearer v', enabled: true })
    expect(r.body).toEqual({ mode: 'raw', language: 'json', content: '{"v":"v"}' })
    expect(r.auth).toEqual({ type: 'bearer', token: 'T' })
  })
  it('resolves disabled rows but keeps them disabled', () => {
    const r = resolveRequest(base(), [scope])
    expect(r.params[1]).toEqual({ key: 'off', value: 'v', enabled: false })
    expect(r.headers[1]).toEqual({ key: 'X-Off', value: 'v', enabled: false })
  })
  it('keeps id, name and method untouched', () => {
    const r = resolveRequest(base(), [scope])
    expect([r.id, r.name, r.method]).toEqual(['r1', 'Req {{a}}', 'POST'])
  })
  it('resolves basic auth', () => {
    const req = { ...base(), auth: { type: 'basic' as const, username: '{{user}}', password: '{{pass}}' } }
    expect(resolveRequest(req, [scope]).auth).toEqual({ type: 'basic', username: 'u', password: 'p' })
  })
  it('resolves apikey auth', () => {
    const req = { ...base(), auth: { type: 'apikey' as const, key: '{{pk}}', value: '{{tok}}', in: 'query' as const } }
    expect(resolveRequest(req, [scope]).auth).toEqual({ type: 'apikey', key: 'k', value: 'T', in: 'query' })
  })
  it('resolves urlencoded and formdata fields', () => {
    const fields = [{ key: '{{pk}}', value: '{{pv}}', enabled: false, description: 'd' }]
    for (const mode of ['urlencoded', 'formdata'] as const) {
      const r = resolveRequest({ ...base(), body: { mode, fields } }, [scope])
      expect(r.body).toEqual({ mode, fields: [{ key: 'k', value: 'v', enabled: false, description: 'd' }] })
    }
  })
  it('passes none/inherit auth and none body through', () => {
    const r = resolveRequest({ ...base(), body: { mode: 'none' }, auth: { type: 'inherit' } }, [scope])
    expect(r.body).toEqual({ mode: 'none' })
    expect(r.auth).toEqual({ type: 'inherit' })
  })
  it('does not mutate the input', () => {
    const req = base()
    const snapshot = structuredClone(req)
    const r = resolveRequest(req, [scope])
    expect(req).toEqual(snapshot)
    expect(r).not.toBe(req)
  })
})
