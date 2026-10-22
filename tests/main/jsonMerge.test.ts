import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyChoices, fileKind, mergeJson, type FieldConflict, type MergeOutcome } from '../../src/main/git/jsonMerge'
import { writeJsonAtomic } from '../../src/main/storage/fsJson'

const fmt = (v: unknown): string => JSON.stringify(v, null, 2) + '\n'

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    name: 'Get users',
    method: 'GET',
    url: 'https://api.test/users',
    params: [{ key: 'page', value: '1', enabled: true }],
    headers: [
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'Authorization', value: 'Bearer a', enabled: true }
    ],
    body: { mode: 'none' },
    auth: { type: 'inherit' },
    scripts: { preRequest: '', postResponse: '' },
    ...over
  }
}

function merged(outcome: MergeOutcome): unknown {
  expect(outcome.kind).toBe('merged')
  if (outcome.kind !== 'merged') throw new Error('not merged')
  return JSON.parse(outcome.text)
}

function conflicts(outcome: MergeOutcome): { partial: unknown; conflicts: FieldConflict[] } {
  expect(outcome.kind).toBe('conflicts')
  if (outcome.kind !== 'conflicts') throw new Error('no conflicts')
  return outcome
}

describe('fileKind', () => {
  it('classifies workspace files by name', () => {
    expect(fileKind('collections/api/users/get-users.request.json')).toBe('request')
    expect(fileKind('collections/api/users/folder.json')).toBe('folder')
    expect(fileKind('collections/api/collection.json')).toBe('collection')
    expect(fileKind('environments/dev.json')).toBe('environment')
    expect(fileKind('workspace.json')).toBe('workspace')
  })

  it('treats everything else as other', () => {
    expect(fileKind('.gitignore')).toBe('other')
    expect(fileKind('README.md')).toBe('other')
    expect(fileKind('.local/environments/dev.json')).toBe('other')
    expect(fileKind('environments/nested/dev.json')).toBe('other')
    expect(fileKind('collections/api/workspace.json')).toBe('other')
  })

  it('accepts backslash separators', () => {
    expect(fileKind('environments\\dev.json')).toBe('environment')
  })
})

describe('mergeJson: scalars and objects', () => {
  it('merges changes to different fields from both sides', () => {
    const base = request()
    const ours = request({ url: 'https://api.test/people' })
    const theirs = request({ method: 'POST' })
    expect(merged(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))).toEqual(
      request({ url: 'https://api.test/people', method: 'POST' })
    )
  })

  it('writes merged output byte-identical to writeJsonAtomic', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'am-jsonmerge-'))
    try {
      const expected = request({ url: 'https://api.test/people', method: 'POST' })
      const file = path.join(dir, 'x.request.json')
      await writeJsonAtomic(file, expected)
      const outcome = mergeJson(
        'request',
        fmt(request()),
        fmt(request({ url: 'https://api.test/people' })),
        fmt(request({ method: 'POST' }))
      )
      expect(outcome).toEqual({ kind: 'merged', text: await fsp.readFile(file, 'utf8') })
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('does not conflict when both sides make the same change', () => {
    const base = request()
    const both = request({ url: 'https://api.test/v2/users' })
    expect(merged(mergeJson('request', fmt(base), fmt(both), fmt(both)))).toEqual(both)
  })

  it('reports a conflict when both sides change a field differently', () => {
    const base = request()
    const ours = request({ url: 'https://api.test/a', method: 'PUT' })
    const theirs = request({ url: 'https://api.test/b' })
    const { partial, conflicts: list } = conflicts(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      label: 'URL',
      ours: 'https://api.test/a',
      theirs: 'https://api.test/b',
      base: 'https://api.test/users'
    })
    // The non-conflicting change is already in the partial result.
    expect((partial as { method: string }).method).toBe('PUT')
    expect(applyChoices('request', partial, list, () => 'ours')).toBe(
      fmt(request({ url: 'https://api.test/a', method: 'PUT' }))
    )
    expect(applyChoices('request', partial, list, () => 'theirs')).toBe(
      fmt(request({ url: 'https://api.test/b', method: 'PUT' }))
    )
  })

  it('merges nested objects field by field', () => {
    const base = request()
    const ours = request({ scripts: { preRequest: 'a()', postResponse: '' } })
    const theirs = request({ scripts: { preRequest: '', postResponse: 'b()' } })
    expect(merged(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))).toEqual(
      request({ scripts: { preRequest: 'a()', postResponse: 'b()' } })
    )
  })

  it('merges a workspace file', () => {
    const base = { version: 1, id: 'w', name: 'Old' }
    expect(
      merged(mergeJson('workspace', fmt(base), fmt({ ...base, name: 'New' }), fmt(base)))
    ).toEqual({ version: 1, id: 'w', name: 'New' })
  })
})

describe('mergeJson: strings are atomic', () => {
  it('conflicts on scripts changed on both sides, with no line merge', () => {
    const base = request({ scripts: { preRequest: 'line1\nline2\n', postResponse: '' } })
    const ours = request({ scripts: { preRequest: 'LINE1\nline2\n', postResponse: '' } })
    const theirs = request({ scripts: { preRequest: 'line1\nLINE2\n', postResponse: '' } })
    const { partial, conflicts: list } = conflicts(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))
    expect(list).toHaveLength(1)
    expect(list[0].label).toBe('Pre-request script')
    expect(JSON.parse(applyChoices('request', partial, list, () => 'theirs'))).toEqual(theirs)
  })

  it('labels a post-response script conflict', () => {
    const base = request()
    const ours = request({ scripts: { preRequest: '', postResponse: 'a' } })
    const theirs = request({ scripts: { preRequest: '', postResponse: 'b' } })
    const { conflicts: list } = conflicts(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))
    expect(list.map((c) => c.label)).toEqual(['Post-response script'])
  })

  it('conflicts on a raw body changed on both sides', () => {
    const raw = (content: string): Record<string, unknown> => ({ mode: 'raw', language: 'json', content })
    const base = request({ body: raw('{}') })
    const ours = request({ body: raw('{"a":1}') })
    const theirs = request({ body: raw('{"b":2}') })
    const { partial, conflicts: list } = conflicts(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))
    expect(list.map((c) => [c.label, c.ours, c.theirs])).toEqual([['Body', '{"a":1}', '{"b":2}']])
    expect(JSON.parse(applyChoices('request', partial, list, () => 'ours'))).toEqual(ours)
  })
})

describe('mergeJson: keyed arrays', () => {
  it('adds elements added on either side: theirs order, then ours additions', () => {
    const base = request()
    const h = (key: string): Record<string, unknown> => ({ key, value: key.toLowerCase(), enabled: true })
    const baseHeaders = (base.headers as unknown[]).slice()
    const ours = request({ headers: [...baseHeaders, h('X-Ours-1'), h('X-Ours-2')] })
    const theirs = request({ headers: [h('X-Theirs'), ...baseHeaders] })
    const result = merged(mergeJson('request', fmt(base), fmt(ours), fmt(theirs))) as { headers: { key: string }[] }
    expect(result.headers.map((x) => x.key)).toEqual(['X-Theirs', 'Accept', 'Authorization', 'X-Ours-1', 'X-Ours-2'])
  })

  it('removes an element removed on one side and unchanged on the other', () => {
    const base = request()
    const ours = request({ headers: [(base.headers as unknown[])[0]] })
    const theirs = request({ method: 'POST' })
    const result = merged(mergeJson('request', fmt(base), fmt(ours), fmt(theirs))) as {
      headers: { key: string }[]
      method: string
    }
    expect(result.headers.map((x) => x.key)).toEqual(['Accept'])
    expect(result.method).toBe('POST')
  })

  it('conflicts when an element is removed on one side and changed on the other', () => {
    const base = request()
    const accept = (base.headers as unknown[])[0]
    const changedAuth = { key: 'Authorization', value: 'Bearer b', enabled: true }
    const ours = request({ headers: [accept, changedAuth] })
    const theirs = request({ headers: [accept], params: [] })
    const { partial, conflicts: list } = conflicts(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'Header "Authorization"', ours: changedAuth, theirs: undefined })
    // Keep mine restores the element; the other non-conflicting change (params removed) stays applied.
    expect(JSON.parse(applyChoices('request', partial, list, () => 'ours'))).toEqual(
      request({ headers: [accept, changedAuth], params: [] })
    )
    expect(JSON.parse(applyChoices('request', partial, list, () => 'theirs'))).toEqual(
      request({ headers: [accept], params: [] })
    )
  })

  it('conflicts the other way round: removed on ours, changed on theirs', () => {
    const base = request()
    const accept = (base.headers as unknown[])[0]
    const changedAuth = { key: 'Authorization', value: 'Bearer t', enabled: true }
    const ours = request({ headers: [accept] })
    const theirs = request({ headers: [accept, changedAuth] })
    const { partial, conflicts: list } = conflicts(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))
    expect(list[0]).toMatchObject({ ours: undefined, theirs: changedAuth })
    expect(JSON.parse(applyChoices('request', partial, list, () => 'ours'))).toEqual(request({ headers: [accept] }))
    expect(JSON.parse(applyChoices('request', partial, list, () => 'theirs'))).toEqual(theirs)
  })

  it('merges an element changed on both sides recursively', () => {
    const base = request()
    const accept = (base.headers as unknown[])[0]
    const ours = request({ headers: [accept, { key: 'Authorization', value: 'Bearer o', enabled: true }] })
    const theirs = request({ headers: [accept, { key: 'Authorization', value: 'Bearer a', enabled: false }] })
    const result = merged(mergeJson('request', fmt(base), fmt(ours), fmt(theirs))) as { headers: unknown[] }
    expect(result.headers).toEqual([accept, { key: 'Authorization', value: 'Bearer o', enabled: false }])
  })

  it('labels a conflict inside an element by the element', () => {
    const base = request()
    const p = (value: string): Record<string, unknown>[] => [{ key: 'page', value, enabled: true }]
    const { partial, conflicts: list } = conflicts(
      mergeJson('request', fmt(base), fmt(request({ params: p('2') })), fmt(request({ params: p('3') })))
    )
    expect(list.map((c) => [c.label, c.ours, c.theirs, c.base])).toEqual([['Query param "page"', '2', '3', '1']])
    expect(JSON.parse(applyChoices('request', partial, list, () => 'theirs'))).toEqual(request({ params: p('3') }))
  })

  it('merges body fields by key when the mode is the same', () => {
    const f = (fields: unknown[]): Record<string, unknown> => ({ body: { mode: 'urlencoded', fields } })
    const a = { key: 'a', value: '1', enabled: true }
    const base = request(f([a]))
    const ours = request(f([a, { key: 'b', value: '2', enabled: true }]))
    const theirs = request(f([{ ...a, value: '9' }]))
    expect(merged(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))).toEqual(
      request(f([{ ...a, value: '9' }, { key: 'b', value: '2', enabled: true }]))
    )
    const { conflicts: list } = conflicts(
      mergeJson('request', fmt(base), fmt(request(f([{ ...a, value: '5' }]))), fmt(theirs))
    )
    expect(list.map((c) => c.label)).toEqual(['Body field "a"'])
  })

  it('treats an array with duplicate keys as one atomic value', () => {
    const base = request()
    const dup = { key: 'Accept', value: 'text/plain', enabled: true }
    const ours = request({ headers: [...(base.headers as unknown[]), dup] })
    const theirs = request({ headers: [{ key: 'X-New', value: '1', enabled: true }, ...(base.headers as unknown[])] })
    const { partial, conflicts: list } = conflicts(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'Headers', ours: ours.headers, theirs: theirs.headers })
    expect(JSON.parse(applyChoices('request', partial, list, () => 'ours'))).toEqual(ours)
  })

  it('merges collection variables by key', () => {
    const v = (key: string, value: string): Record<string, unknown> => ({ key, value, enabled: true })
    const col = (variables: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: 'c',
      name: 'API',
      order: [],
      variables,
      auth: { type: 'none' },
      ...over
    })
    const base = col([v('host', 'a')])
    expect(
      merged(mergeJson('collection', fmt(base), fmt(col([v('host', 'a'), v('token', 't')])), fmt(col([v('host', 'b')]))))
    ).toEqual(col([v('host', 'b'), v('token', 't')]))
    const { conflicts: list } = conflicts(
      mergeJson('collection', fmt(base), fmt(col([v('host', 'x')])), fmt(col([v('host', 'y')])))
    )
    expect(list.map((c) => c.label)).toEqual(['Variable "host"'])
  })

  it('merges environment variables by key', () => {
    const v = (key: string, value: string, secret = false): Record<string, unknown> => ({
      key,
      value,
      secret,
      enabled: true
    })
    const env = (variables: unknown[]): Record<string, unknown> => ({ id: 'e', name: 'Dev', variables })
    const base = env([v('host', 'h'), v('token', '')])
    const ours = env([v('host', 'h'), v('token', '', true)])
    const theirs = env([v('host', 'h2'), v('token', '')])
    expect(merged(mergeJson('environment', fmt(base), fmt(ours), fmt(theirs)))).toEqual(
      env([v('host', 'h2'), v('token', '', true)])
    )
    const { partial, conflicts: list } = conflicts(
      mergeJson('environment', fmt(base), fmt(env([v('host', 'h'), v('token', 'x')])), fmt(env([v('host', 'h'), v('token', 'y')])))
    )
    expect(list.map((c) => c.label)).toEqual(['Variable "token"'])
    expect(JSON.parse(applyChoices('environment', partial, list, () => 'ours'))).toEqual(
      env([v('host', 'h'), v('token', 'x')])
    )
  })
})

describe('mergeJson: order arrays', () => {
  const folder = (order: string[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'f',
    name: 'Users',
    order,
    ...over
  })

  it('unions two different requests added to the same folder (Review Focus 2)', () => {
    const base = folder(['list.request.json'])
    const ours = folder(['list.request.json', 'create.request.json'])
    const theirs = folder(['list.request.json', 'delete.request.json'])
    expect(merged(mergeJson('folder', fmt(base), fmt(ours), fmt(theirs)))).toEqual(
      folder(['list.request.json', 'delete.request.json', 'create.request.json'])
    )
  })

  it('applies removals from either side', () => {
    const base = folder(['a', 'b', 'c'])
    const ours = folder(['a', 'c', 'd'])
    const theirs = folder(['c', 'a', 'b', 'e'])
    expect(merged(mergeJson('folder', fmt(base), fmt(ours), fmt(theirs)))).toEqual(folder(['c', 'a', 'e', 'd']))
  })

  it('unions the order of a collection', () => {
    const col = (order: string[]): Record<string, unknown> => ({
      id: 'c',
      name: 'API',
      order,
      variables: [],
      auth: { type: 'none' }
    })
    expect(
      merged(mergeJson('collection', fmt(col(['users'])), fmt(col(['users', 'auth'])), fmt(col(['orders', 'users']))))
    ).toEqual(col(['orders', 'users', 'auth']))
  })
})

describe('mergeJson: body mode and auth type', () => {
  it('makes the whole body one conflict when the mode differs', () => {
    const base = request()
    const ours = request({ body: { mode: 'raw', language: 'json', content: '{}' } })
    const theirs = request({ body: { mode: 'urlencoded', fields: [] } })
    const { partial, conflicts: list } = conflicts(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'Body', ours: ours.body, theirs: theirs.body, base: base.body })
    expect(JSON.parse(applyChoices('request', partial, list, () => 'theirs'))).toEqual(theirs)
    expect(JSON.parse(applyChoices('request', partial, list, () => 'ours'))).toEqual(ours)
  })

  it('makes the whole auth one conflict when the type differs', () => {
    const base = request({ auth: { type: 'bearer', token: 't' } })
    const ours = request({ auth: { type: 'basic', username: 'u', password: 'p' } })
    const theirs = request({ auth: { type: 'bearer', token: 't2' } })
    const { partial, conflicts: list } = conflicts(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'Auth', ours: ours.auth, theirs: theirs.auth })
    expect(JSON.parse(applyChoices('request', partial, list, () => 'ours'))).toEqual(ours)
  })

  it('merges auth fields when the type is the same', () => {
    const base = request({ auth: { type: 'basic', username: 'u', password: 'p' } })
    const ours = request({ auth: { type: 'basic', username: 'u2', password: 'p' } })
    const theirs = request({ auth: { type: 'basic', username: 'u', password: 'p2' } })
    expect(merged(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))).toEqual(
      request({ auth: { type: 'basic', username: 'u2', password: 'p2' } })
    )
  })
})

describe('mergeJson: unmergeable', () => {
  const ok = fmt(request())

  it('rejects invalid JSON on any side (Review Focus 5)', () => {
    for (const [b, o, t] of [
      ['{', ok, ok],
      [ok, '{"id":', ok],
      [ok, ok, '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n']
    ]) {
      expect(mergeJson('request', b, o, t).kind).toBe('unmergeable')
    }
  })

  it('rejects a missing side', () => {
    expect(mergeJson('request', null, ok, ok).kind).toBe('unmergeable')
    expect(mergeJson('request', ok, null, ok).kind).toBe('unmergeable')
    expect(mergeJson('request', ok, ok, null).kind).toBe('unmergeable')
  })

  it('rejects files of kind other', () => {
    expect(mergeJson('other', '{}', '{"a":1}', '{"b":2}')).toMatchObject({ kind: 'unmergeable' })
  })
})

describe('applyChoices', () => {
  it('resolves several conflicts with different choices', () => {
    const base = request()
    const ours = request({ url: 'https://o', name: 'Ours' })
    const theirs = request({ url: 'https://t', name: 'Theirs' })
    const { partial, conflicts: list } = conflicts(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))
    expect(list.map((c) => c.label).sort()).toEqual(['Name', 'URL'])
    const text = applyChoices('request', partial, list, (c) => (c.label === 'URL' ? 'ours' : 'theirs'))
    expect(text).toBe(fmt(request({ url: 'https://o', name: 'Theirs' })))
  })

  it('works on conflicts that went through a JSON round trip (IPC)', () => {
    const base = request()
    const accept = (base.headers as unknown[])[0]
    const ours = request({ headers: [accept] })
    const theirs = request({ headers: [accept, { key: 'Authorization', value: 'Bearer t', enabled: true }] })
    const out = conflicts(mergeJson('request', fmt(base), fmt(ours), fmt(theirs)))
    const copy = JSON.parse(JSON.stringify(out)) as { partial: unknown; conflicts: FieldConflict[] }
    expect(JSON.parse(applyChoices('request', copy.partial, copy.conflicts, () => 'ours'))).toEqual(ours)
  })

  it('does not mutate the partial value', () => {
    const base = request()
    const out = conflicts(
      mergeJson('request', fmt(base), fmt(request({ url: 'https://o' })), fmt(request({ url: 'https://t' })))
    )
    const before = JSON.stringify(out.partial)
    applyChoices('request', out.partial, out.conflicts, () => 'theirs')
    expect(JSON.stringify(out.partial)).toBe(before)
  })
})
