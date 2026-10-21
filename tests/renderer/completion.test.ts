import { describe, expect, it } from 'vitest'
import {
  completionAt,
  filterOptions,
  insertCompletion,
  MAX_OPTIONS,
  optionValue,
} from '../../src/renderer/src/lib/completion'
import { variableOptions, type Resolution } from '../../src/renderer/src/lib/variables'
import type { CollectionTree, Environment } from '../../src/shared/types'

const option = (name: string, extra: Partial<Resolution> = {}): Resolution => ({
  name,
  value: `v-${name}`,
  secret: false,
  source: 'environment',
  scopeName: 'Dev',
  ...extra,
})

describe('completionAt', () => {
  it('opens after {{ and a partial name made of word characters, dots and dashes', () => {
    expect(completionAt('{{', 2)).toEqual({ from: 2, prefix: '' })
    expect(completionAt('http://{{base', 13)).toEqual({ from: 9, prefix: 'base' })
    expect(completionAt('{{a.b-c_1', 9)).toEqual({ from: 2, prefix: 'a.b-c_1' })
    // Only the text before the caret counts.
    expect(completionAt('{{base}}/x', 6)).toEqual({ from: 2, prefix: 'base' })
  })

  it('stays closed elsewhere', () => {
    expect(completionAt('{', 1)).toBeNull()
    expect(completionAt('{{a b', 5)).toBeNull()
    expect(completionAt('{{base}}', 8)).toBeNull()
    expect(completionAt('plain', 5)).toBeNull()
  })
})

describe('filterOptions', () => {
  it('puts prefix matches first, then substring matches, ignoring case', () => {
    const options = [option('userToken'), option('token'), option('tokenTtl'), option('host')]
    expect(filterOptions(options, 'tok').map((o) => o.name)).toEqual(['token', 'tokenTtl', 'userToken'])
    expect(filterOptions(options, 'TOK').map((o) => o.name)).toEqual(['token', 'tokenTtl', 'userToken'])
    expect(filterOptions(options, '').map((o) => o.name)).toEqual(['userToken', 'token', 'tokenTtl', 'host'])
    expect(filterOptions(options, 'zzz')).toEqual([])
  })

  it('offers at most 50 options', () => {
    const many = Array.from({ length: 80 }, (_, i) => option(`v${i}`))
    expect(filterOptions(many, 'v')).toHaveLength(MAX_OPTIONS)
  })
})

describe('insertCompletion', () => {
  it('replaces the typed prefix with name}} and puts the caret after it', () => {
    expect(insertCompletion('http://{{ba/x', 9, 11, 'baseUrl')).toEqual({
      text: 'http://{{baseUrl}}/x',
      caret: 18,
      insert: 'baseUrl}}',
    })
  })

  it('does not add a second }} when one follows the caret', () => {
    expect(insertCompletion('{{ba}}/x', 2, 4, 'baseUrl')).toEqual({
      text: '{{baseUrl}}/x',
      caret: 11,
      insert: 'baseUrl',
    })
  })
})

describe('optionValue', () => {
  it('masks secrets', () => {
    expect(optionValue(option('t', { value: 'hunter2', secret: true }))).toBe('••••')
    expect(optionValue(option('t', { value: 'plain' }))).toBe('plain')
  })
})

describe('variableOptions', () => {
  const env: Environment = {
    id: 'dev',
    name: 'Dev',
    variables: [
      { key: 'host', value: 'dev.host', secret: false, enabled: true },
      { key: 'token', value: '', currentValue: 's3cret', secret: true, enabled: true },
      { key: 'off', value: 'x', secret: false, enabled: false },
    ],
  }
  const globals: Environment = {
    id: 'globals',
    name: 'Globals',
    variables: [
      { key: 'host', value: 'global.host', secret: false, enabled: true },
      { key: 'g', value: 'gv', secret: false, enabled: true },
    ],
  }
  const collection = {
    id: 'c',
    name: 'Shop',
    path: 'collections/shop',
    variables: [
      { key: 'g', value: 'collection-g', enabled: true },
      { key: 'c', value: 'cv', enabled: true },
    ],
    auth: { type: 'none' },
    children: [],
  } as CollectionTree

  it('lists every enabled name once, with the value that wins when sending', () => {
    const options = variableOptions([env, globals], 'dev', collection)
    expect(options.map((o) => [o.name, o.value, o.source])).toEqual([
      ['host', 'dev.host', 'environment'],
      ['token', 's3cret', 'environment'],
      ['g', 'collection-g', 'collection'],
      ['c', 'cv', 'collection'],
    ])
    expect(options.find((o) => o.name === 'token')?.secret).toBe(true)
  })

  it('uses only the globals and the collection without an active environment', () => {
    expect(variableOptions([env, globals], null, undefined).map((o) => [o.name, o.source])).toEqual([
      ['host', 'globals'],
      ['g', 'globals'],
    ])
  })
})
