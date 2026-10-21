import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportFileName, toPostmanCollection, toPostmanEnvironment } from '../../src/main/postman/exporter'
import { parsePostman } from '../../src/main/postman/importer'
import type { ImportedCollection, ImportedEnvironment, ImportedNode, Parsed } from '../../src/main/postman/importer'
import type { Auth, CollectionTree, Environment, RequestItem, TreeNode } from '../../src/shared/types'

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'

const fixture = (name: string) => readFileSync(resolve(__dirname, '../fixtures/postman', name), 'utf8')

function collectionOf(parsed: Parsed): ImportedCollection {
  if (parsed.kind !== 'collection') throw new Error(`expected a collection, got ${parsed.kind}`)
  return parsed.collection
}

function environmentOf(parsed: Parsed): ImportedEnvironment {
  if (parsed.kind !== 'environment') throw new Error(`expected an environment, got ${parsed.kind}`)
  return parsed.environment
}

/** Gives imported nodes ids and paths, the way the store does when it writes them. */
function treeOf(collection: ImportedCollection): CollectionTree {
  let n = 0
  const nodes = (children: ImportedNode[], parent: string): TreeNode[] =>
    children.map((child): TreeNode => {
      const id = `id-${++n}`
      const path = `${parent}/${id}`
      if (child.kind === 'folder') {
        const folder: TreeNode = { kind: 'folder', id, name: child.name, path, children: nodes(child.children, path) }
        if (child.scripts) folder.scripts = child.scripts
        return folder
      }
      return { kind: 'request', id, name: child.request.name, path, request: { ...child.request, id }, revision: '' }
    })
  const tree: CollectionTree = {
    id: 'collection-id',
    name: collection.name,
    path: 'collections/c',
    variables: collection.variables,
    auth: collection.auth,
    children: nodes(collection.children, 'collections/c'),
  }
  if (collection.scripts) tree.scripts = collection.scripts
  return tree
}

function request(overrides: Partial<RequestItem> = {}): RequestItem {
  return {
    id: 'r1',
    name: 'R',
    method: 'GET',
    url: 'https://api.example.com/a',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'inherit' },
    ...overrides,
  }
}

function tree(children: TreeNode[], overrides: Partial<CollectionTree> = {}): CollectionTree {
  return { id: 'c1', name: 'C', path: 'collections/c', variables: [], auth: { type: 'none' }, children, ...overrides }
}

const requestNode = (r: RequestItem): TreeNode => ({
  kind: 'request',
  id: r.id,
  name: r.name,
  path: r.id,
  request: r,
  revision: '',
})

type Json = Record<string, unknown>

/** The exported item of a collection made of one request. */
function exportRequest(overrides: Partial<RequestItem> = {}): Json {
  const items = toPostmanCollection(tree([requestNode(request(overrides))])).item as Json[]
  return items[0]
}

const exportedRequest = (overrides: Partial<RequestItem> = {}) => exportRequest(overrides).request as Json

describe('toPostmanCollection: collection fields', () => {
  it('writes info with _postman_id, name and the v2.1 schema', () => {
    expect(toPostmanCollection(tree([])).info).toEqual({ _postman_id: 'c1', name: 'C', schema: SCHEMA })
  })

  it('emits items in tree order, with folders as item arrays', () => {
    const a = request({ id: 'a', name: 'A' })
    const b = request({ id: 'b', name: 'B' })
    const folder: TreeNode = { kind: 'folder', id: 'f', name: 'F', path: 'f', children: [requestNode(b)] }
    const items = toPostmanCollection(tree([folder, requestNode(a)])).item as Json[]
    expect(items.map((i) => i.name)).toEqual(['F', 'A'])
    expect((items[0].item as Json[]).map((i) => i.name)).toEqual(['B'])
    expect(items[1].item).toBeUndefined()
  })

  it('takes folder events from its scripts', () => {
    const folder: TreeNode = {
      kind: 'folder',
      id: 'f',
      name: 'F',
      path: 'f',
      children: [],
      scripts: { preRequest: 'a()', postResponse: '' },
    }
    const items = toPostmanCollection(tree([folder])).item as Json[]
    expect(items[0].event).toEqual([{ listen: 'prerequest', script: { type: 'text/javascript', exec: ['a()'] } }])
  })

  it('leaves out empty collection variables, none auth and empty scripts', () => {
    const exported = toPostmanCollection(tree([], { scripts: { preRequest: '', postResponse: '' } }))
    expect(Object.keys(exported).sort()).toEqual(['info', 'item'])
  })

  it('emits collection variables, auth and events when set', () => {
    const exported = toPostmanCollection(
      tree([], {
        variables: [
          { key: 'a', value: '1', enabled: true },
          { key: 'b', value: '2', enabled: false },
        ],
        auth: { type: 'bearer', token: 't' },
        scripts: { preRequest: '', postResponse: 'done()' },
      }),
    )
    expect(exported.variable).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2', disabled: true },
    ])
    expect(exported.auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: 't', type: 'string' }] })
    expect(exported.event).toEqual([{ listen: 'test', script: { type: 'text/javascript', exec: ['done()'] } }])
  })
})

describe('toPostmanCollection: auth', () => {
  it('writes no auth key for inherit', () => {
    expect(exportedRequest({ auth: { type: 'inherit' } })).not.toHaveProperty('auth')
  })

  it('writes none as noauth', () => {
    expect(exportedRequest({ auth: { type: 'none' } }).auth).toEqual({ type: 'noauth' })
  })

  it('writes bearer, basic and apikey in the v2.1 array form', () => {
    const cases: [Auth, Json][] = [
      [{ type: 'bearer', token: 't' }, { type: 'bearer', bearer: [{ key: 'token', value: 't', type: 'string' }] }],
      [
        { type: 'basic', username: 'u', password: 'p' },
        {
          type: 'basic',
          basic: [
            { key: 'username', value: 'u', type: 'string' },
            { key: 'password', value: 'p', type: 'string' },
          ],
        },
      ],
      [
        { type: 'apikey', key: 'X-Key', value: 'v', in: 'query' },
        {
          type: 'apikey',
          apikey: [
            { key: 'key', value: 'X-Key', type: 'string' },
            { key: 'value', value: 'v', type: 'string' },
            { key: 'in', value: 'query', type: 'string' },
          ],
        },
      ],
    ]
    for (const [auth, expected] of cases) expect(exportedRequest({ auth }).auth).toEqual(expected)
  })
})

describe('toPostmanCollection: bodies', () => {
  it('writes no body for none', () => {
    expect(exportedRequest({ body: { mode: 'none' } })).not.toHaveProperty('body')
  })

  it('writes raw with its language in options', () => {
    expect(exportedRequest({ body: { mode: 'raw', language: 'xml', content: '<a/>' } }).body).toEqual({
      mode: 'raw',
      raw: '<a/>',
      options: { raw: { language: 'xml' } },
    })
  })

  it('writes urlencoded and form-data fields', () => {
    const fields = [
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: '2', enabled: false, description: 'note' },
    ]
    expect(exportedRequest({ body: { mode: 'urlencoded', fields } }).body).toEqual({
      mode: 'urlencoded',
      urlencoded: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2', disabled: true, description: 'note' },
      ],
    })
    expect(exportedRequest({ body: { mode: 'formdata', fields } }).body).toEqual({
      mode: 'formdata',
      formdata: [
        { key: 'a', value: '1', type: 'text' },
        { key: 'b', value: '2', type: 'text', disabled: true, description: 'note' },
      ],
    })
  })
})

describe('toPostmanCollection: requests', () => {
  it('writes method and the url object from toPostmanUrl', () => {
    const exported = exportedRequest({
      method: 'POST',
      url: 'https://api.example.com/a',
      params: [{ key: 'q', value: 'a b', enabled: true }],
    })
    expect(exported.method).toBe('POST')
    expect(exported.url).toEqual({
      raw: 'https://api.example.com/a?q=a%20b',
      protocol: 'https',
      host: ['api', 'example', 'com'],
      path: ['a'],
      query: [{ key: 'q', value: 'a%20b' }],
    })
  })

  it('marks headers disabled only when they are, keeping descriptions', () => {
    const exported = exportedRequest({
      headers: [
        { key: 'A', value: '1', enabled: true },
        { key: 'B', value: '2', enabled: false, description: 'off' },
      ],
    })
    expect(exported.header).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '2', disabled: true, description: 'off' },
    ])
  })
})

describe('toPostmanCollection: events', () => {
  it('splits scripts on newlines into exec', () => {
    const item = exportRequest({ scripts: { preRequest: 'a()\nb()', postResponse: 'c()\r\nd()' } })
    expect(item.event).toEqual([
      { listen: 'prerequest', script: { type: 'text/javascript', exec: ['a()', 'b()'] } },
      { listen: 'test', script: { type: 'text/javascript', exec: ['c()\r', 'd()'] } },
    ])
  })

  it('does not emit empty scripts', () => {
    expect(exportRequest({ scripts: { preRequest: '', postResponse: '' } })).not.toHaveProperty('event')
    expect(exportRequest()).not.toHaveProperty('event')
  })
})

describe('toPostmanEnvironment', () => {
  const env: Environment = {
    id: 'e1',
    name: 'Dev',
    variables: [
      { key: 'host', value: 'h', secret: false, enabled: true },
      { key: 'token', value: '', currentValue: 'shh', secret: true, enabled: false },
    ],
  }

  it('writes id, name, values and the environment scope, with secrets empty', () => {
    expect(toPostmanEnvironment(env)).toEqual({
      id: 'e1',
      name: 'Dev',
      values: [
        { key: 'host', value: 'h', type: 'default', enabled: true },
        { key: 'token', value: '', type: 'secret', enabled: false },
      ],
      _postman_variable_scope: 'environment',
    })
  })

  it('never writes a secret value, even one stored in value', () => {
    const leaky: Environment = { ...env, variables: [{ key: 'k', value: 'oops', secret: true, enabled: true }] }
    expect(JSON.stringify(toPostmanEnvironment(leaky))).not.toContain('oops')
  })

  it('uses the globals scope for the globals environment', () => {
    expect(toPostmanEnvironment({ ...env, id: 'globals' })._postman_variable_scope).toBe('globals')
  })
})

describe('exportFileName', () => {
  it('replaces characters illegal in file names with _', () => {
    expect(exportFileName('A/B: c', 'collection')).toBe('A_B_ c.postman_collection.json')
    expect(exportFileName('a\\b*c?d"e<f>g|h', 'collection')).toBe('a_b_c_d_e_f_g_h.postman_collection.json')
  })

  it('names environments and globals by their Postman suffix', () => {
    expect(exportFileName('Dev', 'environment')).toBe('Dev.postman_environment.json')
    expect(exportFileName('Globals', 'globals')).toBe('Globals.postman_globals.json')
  })

  it('uses Untitled when nothing usable is left of the name', () => {
    expect(exportFileName('', 'collection')).toBe('Untitled.postman_collection.json')
    expect(exportFileName('   ', 'environment')).toBe('Untitled.postman_environment.json')
    expect(exportFileName('/:*?', 'collection')).toBe('Untitled.postman_collection.json')
    expect(exportFileName(' \t/ ', 'collection')).toBe('Untitled.postman_collection.json')
    expect(exportFileName('...', 'globals')).toBe('Untitled.postman_globals.json')
  })

  it('trims trailing dots and spaces from the stem', () => {
    expect(exportFileName('My API. ', 'collection')).toBe('My API.postman_collection.json')
    expect(exportFileName('v1...', 'environment')).toBe('v1.postman_environment.json')
    expect(exportFileName('  Lead', 'collection')).toBe('  Lead.postman_collection.json')
  })
})

describe('round trip through parsePostman', () => {
  it('reproduces the collection imported from full.v21', () => {
    const imported = collectionOf(parsePostman(fixture('full.v21.postman_collection.json')))
    const exported = toPostmanCollection(treeOf(imported))
    expect(exported.info).toMatchObject({ _postman_id: 'collection-id', schema: SCHEMA })
    const again = parsePostman(JSON.stringify(exported))
    expect(again.warnings).toEqual([])
    expect(collectionOf(again)).toEqual(imported)
  })

  it('reproduces the collection imported from legacy.v20', () => {
    const imported = collectionOf(parsePostman(fixture('legacy.v20.postman_collection.json')))
    expect(collectionOf(parsePostman(JSON.stringify(toPostmanCollection(treeOf(imported)))))).toEqual(imported)
  })

  const roundTrip = (file: string, id: string) => {
    const imported = environmentOf(parsePostman(fixture(file)))
    const env: Environment = { id, name: imported.name, variables: imported.variables }
    return { imported, again: environmentOf(parsePostman(JSON.stringify(toPostmanEnvironment(env)))) }
  }
  const withoutCurrent = (e: ImportedEnvironment) => ({
    ...e,
    variables: e.variables.map(({ currentValue: _, ...v }) => v),
  })

  it('reproduces the environment from dev.postman_environment.json, with secrets coming back empty', () => {
    const { imported, again } = roundTrip('dev.postman_environment.json', 'dev')
    expect(again.scope).toBe('environment')
    expect(again).toEqual(withoutCurrent(imported))
    expect(again.variables.filter((v) => v.secret).map((v) => v.value)).toEqual(['', ''])
    expect(imported.variables.some((v) => v.currentValue !== undefined)).toBe(true)
  })

  it('reproduces globals, with secrets coming back empty', () => {
    const { imported, again } = roundTrip('workspace.postman_globals.json', 'globals')
    expect(again.scope).toBe('globals')
    expect(again).toEqual(withoutCurrent(imported))
    expect(JSON.stringify(again)).not.toContain('k-987')
  })
})
