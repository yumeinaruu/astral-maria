// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fromBulkText, toBulkText } from '../../src/renderer/src/lib/bulkEdit'
import { prettyXml } from '../../src/renderer/src/lib/body'
import { segmentsOf, variableLookup } from '../../src/renderer/src/lib/variables'
import type { Environment, KeyValue } from '../../src/shared/types'
import { collectionTree } from './helpers'

describe('segmentsOf', () => {
  it('splits plain text and variable tokens and joins back losslessly', () => {
    const text = 'a{{x}}b{{ y }}{{a b}}{{}}{c}'
    const parts = segmentsOf(text)
    expect(parts.map((p) => p.text).join('')).toBe(text)
    expect(parts.filter((p) => p.variable !== undefined).map((p) => p.variable)).toEqual(['x', 'y', '', ''])
  })
})

describe('variableLookup', () => {
  const env = (id: string, name: string, variables: Environment['variables']): Environment => ({ id, name, variables })
  const collection = {
    ...collectionTree('collections/c', 'Coll'),
    variables: [{ key: 'c', value: 'C', enabled: true }],
  }

  it('takes the environment first, then the collection, then the globals, like sending', () => {
    const lookup = variableLookup(
      [
        env('e', 'Dev', [
          { key: 'c', value: 'from-env', secret: false, enabled: true },
          { key: 'off', value: 'x', secret: false, enabled: false },
          { key: 's', value: '', currentValue: 'sec', secret: true, enabled: true },
        ]),
        env('globals', 'Globals', [
          { key: 'g', value: 'G', secret: false, enabled: true },
          { key: 'c', value: 'from-globals', secret: false, enabled: true },
        ]),
      ],
      'e',
      collection,
    )
    expect(lookup('c')).toMatchObject({ value: 'from-env', source: 'environment', scopeName: 'Dev' })
    expect(lookup('g')).toMatchObject({ value: 'G', source: 'globals' })
    expect(lookup('s')).toMatchObject({ value: 'sec', secret: true })
    expect(lookup('off')).toBeNull()
    expect(variableLookup([], null, collection)('c')).toMatchObject({
      value: 'C',
      source: 'collection',
      scopeName: 'Coll',
    })
  })
})

describe('bulk edit text', () => {
  it('round-trips rows, keeping descriptions and disabled rows', () => {
    const rows: KeyValue[] = [
      { key: 'a', value: '1', enabled: true, description: 'first' },
      { key: 'b', value: 'http://x:8080', enabled: false },
      { key: 'c', value: '', enabled: true },
    ]
    const text = toBulkText(rows)
    expect(text).toBe('a:1\n//b:http://x:8080\nc:')
    expect(fromBulkText(text, rows)).toEqual(rows)
  })

  it('skips blank lines and trims around the first colon', () => {
    expect(fromBulkText('\n  k : v w \n// d:e\nflag\n', [])).toEqual([
      { key: 'k', value: 'v w', enabled: true },
      { key: 'd', value: 'e', enabled: false },
      { key: 'flag', value: '', enabled: true },
    ])
  })
})

describe('prettyXml', () => {
  it('indents nested elements and keeps text-only elements on one line', () => {
    expect(prettyXml('<?xml version="1.0"?><r><a x="1">t</a><b><c/></b></r>')).toBe(
      '<?xml version="1.0"?>\n<r>\n  <a x="1">t</a>\n  <b>\n    <c/>\n  </b>\n</r>',
    )
  })

  it('leaves malformed XML unchanged', () => {
    expect(prettyXml('<a><b></a>')).toBe('<a><b></a>')
  })
})
