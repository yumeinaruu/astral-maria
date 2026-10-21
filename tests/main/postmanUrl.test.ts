import { describe, expect, it } from 'vitest'
import { splitQuery, toPostmanUrl } from '../../src/main/postman/url'

describe('splitQuery', () => {
  it('splits the query into enabled params and keeps keys without a value', () => {
    expect(splitQuery('{{base}}/a?x=1&y')).toEqual({
      url: '{{base}}/a',
      params: [
        { key: 'x', value: '1', enabled: true },
        { key: 'y', value: '', enabled: true },
      ],
    })
  })
  it('keeps a #fragment in the url', () => {
    expect(splitQuery('https://example.com/a?x=1#top')).toEqual({
      url: 'https://example.com/a#top',
      params: [{ key: 'x', value: '1', enabled: true }],
    })
    expect(splitQuery('https://example.com/a#top')).toEqual({ url: 'https://example.com/a#top', params: [] })
  })
  it('leaves values as written, without decoding them', () => {
    expect(splitQuery('/s?q=a%20b&t=x+y').params).toEqual([
      { key: 'q', value: 'a%20b', enabled: true },
      { key: 't', value: 'x+y', enabled: true },
    ])
  })
  it('splits only on the first = and skips empty pairs', () => {
    expect(splitQuery('/s?a=b=c&&d=').params).toEqual([
      { key: 'a', value: 'b=c', enabled: true },
      { key: 'd', value: '', enabled: true },
    ])
  })
  it('does not split inside {{variables}}', () => {
    expect(splitQuery('/s?a={{x?y}}')).toEqual({ url: '/s', params: [{ key: 'a', value: '{{x?y}}', enabled: true }] })
  })
  it('returns a URL without a query unchanged', () => {
    expect(splitQuery('https://example.com')).toEqual({ url: 'https://example.com', params: [] })
  })
})

describe('toPostmanUrl', () => {
  it('splits protocol, host, port and path', () => {
    const url = toPostmanUrl('https://api.example.com:8443/v1/users', [{ key: 'page', value: '2', enabled: true }])
    expect(url).toEqual({
      raw: 'https://api.example.com:8443/v1/users?page=2',
      protocol: 'https',
      host: ['api', 'example', 'com'],
      port: '8443',
      path: ['v1', 'users'],
      query: [{ key: 'page', value: '2' }],
    })
  })
  it('keeps a {{variable}} host as one segment', () => {
    const url = toPostmanUrl('{{base}}/users', [])
    expect(url.host).toEqual(['{{base}}'])
    expect(url.path).toEqual(['users'])
    expect(url.protocol).toBeUndefined()
    expect(url.raw).toBe('{{base}}/users')
  })
  it('puts only enabled params in raw', () => {
    const url = toPostmanUrl('https://example.com/a', [
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: '2', enabled: false },
      { key: 'c', value: '', enabled: true },
    ])
    expect(url.raw).toBe('https://example.com/a?a=1&c=')
  })
  it('lists disabled params in query with disabled: true', () => {
    const url = toPostmanUrl('https://example.com/a', [
      { key: 'a', value: '1', enabled: true, description: 'first' },
      { key: 'b', value: '2', enabled: false },
    ])
    expect(url.query).toEqual([
      { key: 'a', value: '1', description: 'first' },
      { key: 'b', value: '2', disabled: true },
    ])
  })
  it('puts the query before a #fragment and leaves the fragment out of the path', () => {
    const url = toPostmanUrl('https://example.com/a#top', [{ key: 'x', value: '1', enabled: true }])
    expect(url.raw).toBe('https://example.com/a?x=1#top')
    expect(url.path).toEqual(['a'])
  })
  it('omits path and query when there are none', () => {
    const url = toPostmanUrl('https://example.com', [])
    expect(url).toEqual({ raw: 'https://example.com', protocol: 'https', host: ['example', 'com'] })
  })
})
