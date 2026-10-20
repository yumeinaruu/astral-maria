import { describe, expect, it } from 'vitest'
import { composeUrl, splitUrl } from '../../src/renderer/src/lib/url'
import type { KeyValue } from '../../src/shared/types'

const kv = (key: string, value: string, enabled = true): KeyValue => ({ key, value, enabled })

describe('composeUrl', () => {
  it('ignores ? and # inside {{variables}} of the base', () => {
    expect(composeUrl('http://h/{{x#y}}', [kv('q', '1')])).toBe('http://h/{{x#y}}?q=1')
    expect(composeUrl('http://h/{{a?b}}', [kv('q', '1')])).toBe('http://h/{{a?b}}?q=1')
  })

  it('appends enabled params only and encodes them', () => {
    expect(composeUrl('http://a/x', [kv('q', '1 2'), kv('z', '9', false)])).toBe('http://a/x?q=1%202')
  })

  it('returns the base when there are no enabled params', () => {
    expect(composeUrl('http://a/x', [kv('z', '9', false)])).toBe('http://a/x')
  })

  it('puts the query before a fragment', () => {
    expect(composeUrl('http://a/x#top', [kv('q', '1')])).toBe('http://a/x?q=1#top')
  })

  it('never encodes {{variables}}', () => {
    expect(composeUrl('{{baseUrl}}/path', [kv('x', '{{y}}'), kv('{{k}}', 'a&b')])).toBe(
      '{{baseUrl}}/path?x={{y}}&{{k}}=a%26b',
    )
  })

  it('skips blank rows and encodes reserved characters', () => {
    expect(composeUrl('http://a', [kv('', ''), kv('a&b', 'c=d#e')])).toBe('http://a?a%26b=c%3Dd%23e')
  })
})

describe('splitUrl', () => {
  it('splits the query into params', () => {
    expect(splitUrl('http://a/x?q=1&r=2', [])).toEqual({ url: 'http://a/x', params: [kv('q', '1'), kv('r', '2')] })
  })

  it('decodes values and keeps keys without a value', () => {
    expect(splitUrl('http://a?q=1%202&flag', []).params).toEqual([kv('q', '1 2'), kv('flag', '')])
  })

  it('keeps previously disabled params at the end', () => {
    expect(splitUrl('http://a/x?q=1', [kv('z', '9', false)])).toEqual({
      url: 'http://a/x',
      params: [kv('q', '1'), kv('z', '9', false)],
    })
  })

  it('keeps the descriptions of enabled params with the same key', () => {
    const existing = [{ ...kv('q', '1'), description: 'search' }]
    expect(splitUrl('http://a?q=2', existing).params).toEqual([{ ...kv('q', '2'), description: 'search' }])
  })

  it('keeps the fragment on the base url', () => {
    expect(splitUrl('http://a/x?q=1#frag', [])).toEqual({ url: 'http://a/x#frag', params: [kv('q', '1')] })
  })

  it('leaves invalid escapes and {{variables}} alone', () => {
    expect(splitUrl('{{baseUrl}}/p?x={{y}}&b=%zz', []).params).toEqual([kv('x', '{{y}}'), kv('b', '%zz')])
  })

  it('does not split on ?, #, & or = inside {{variables}}', () => {
    expect(splitUrl('http://h/{{a?b}}/p', [])).toEqual({ url: 'http://h/{{a?b}}/p', params: [] })
    expect(splitUrl('http://h/{{x#y}}?q=1', [])).toEqual({ url: 'http://h/{{x#y}}', params: [kv('q', '1')] })
    expect(splitUrl('http://h?k={{a&b=c}}&z={{p#q}}', []).params).toEqual([kv('k', '{{a&b=c}}'), kv('z', '{{p#q}}')])
    expect(splitUrl('http://h?{{k=v}}=1', []).params).toEqual([kv('{{k=v}}', '1')])
    // An unclosed `{{` is plain text.
    expect(splitUrl('http://h/{{a?b=1', [])).toEqual({ url: 'http://h/{{a', params: [kv('b', '1')] })
  })

  it('round-trips urls unchanged', () => {
    for (const full of [
      '{{baseUrl}}/path?x={{y}}',
      'http://h/{{a?b}}/p?q=1',
      'http://h/{{x#y}}?q={{a&b}}#f',
      'http://a/x?q=1&r=2#frag',
      'http://a/x',
      'http://a/x?q=1%202',
    ]) {
      const { url, params } = splitUrl(full, [])
      expect(composeUrl(url, params)).toBe(full)
    }
  })
})
