import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePostman } from '../../src/main/postman/importer'
import type { ImportedCollection, ImportedEnvironment, ImportedNode, Parsed } from '../../src/main/postman/importer'
import type { RequestItem } from '../../src/shared/types'

const fixture = (name: string) => readFileSync(resolve(__dirname, '../fixtures/postman', name), 'utf8')

function collectionOf(parsed: Parsed): ImportedCollection {
  if (parsed.kind !== 'collection') throw new Error(`expected a collection, got ${parsed.kind}`)
  return parsed.collection
}

function environmentOf(parsed: Parsed): ImportedEnvironment {
  if (parsed.kind !== 'environment') throw new Error(`expected an environment, got ${parsed.kind}`)
  return parsed.environment
}

/** Parses a collection made of `items` (and optional top-level fields) and returns it with its warnings. */
function parseItems(items: unknown[], extra: Record<string, unknown> = {}) {
  const parsed = parsePostman(
    JSON.stringify({
      info: { name: 'T', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: items,
      ...extra,
    }),
  )
  return { collection: collectionOf(parsed), warnings: parsed.warnings }
}

/** The single request of a collection made of one item with `request`. */
function parseRequest(request: unknown, name = 'R') {
  const { collection, warnings } = parseItems([{ name, request }])
  const node = collection.children[0]
  if (node.kind !== 'request') throw new Error('expected a request')
  return { request: node.request, warnings }
}

function find(nodes: ImportedNode[], ...names: string[]): ImportedNode {
  const [first, ...rest] = names
  const node = nodes.find((n) => (n.kind === 'folder' ? n.name : n.request.name) === first)
  if (!node) throw new Error(`no node named ${first}`)
  if (rest.length === 0) return node
  if (node.kind !== 'folder') throw new Error(`${first} is not a folder`)
  return find(node.children, ...rest)
}

function requestAt(nodes: ImportedNode[], ...names: string[]): Omit<RequestItem, 'id'> {
  const node = find(nodes, ...names)
  if (node.kind !== 'request') throw new Error(`${names.join('/')} is not a request`)
  return node.request
}

const full = parsePostman(fixture('full.v21.postman_collection.json'))
const fullCollection = collectionOf(full)
const fullRequest = (...names: string[]) => requestAt(fullCollection.children, ...names)

describe('parsePostman: file detection', () => {
  it('detects collections by info.schema v2.1 or v2.0, or by info plus an item array', () => {
    expect(full.kind).toBe('collection')
    expect(parsePostman(fixture('legacy.v20.postman_collection.json')).kind).toBe('collection')
    expect(parsePostman(JSON.stringify({ info: { name: 'No schema' }, item: [] }))).toEqual({
      kind: 'collection',
      collection: { name: 'No schema', variables: [], auth: { type: 'none' }, children: [] },
      warnings: [],
    })
    expect(
      parsePostman(
        JSON.stringify({ info: { name: 'S', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/' } }),
      ).kind,
    ).toBe('collection')
  })
  it('detects environments by a values array plus a name string, and globals by _postman_variable_scope', () => {
    const dev = environmentOf(parsePostman(fixture('dev.postman_environment.json')))
    expect(dev.name).toBe('Dev')
    expect(dev.scope).toBe('environment')
    const globals = environmentOf(parsePostman(fixture('workspace.postman_globals.json')))
    expect(globals.name).toBe('Workspace Globals')
    expect(globals.scope).toBe('globals')
    expect(parsePostman(JSON.stringify({ name: 'Bare', values: [] }))).toEqual({
      kind: 'environment',
      environment: { name: 'Bare', scope: 'environment', variables: [] },
      warnings: [],
    })
  })
  it('strips a leading BOM', () => {
    const parsed = parsePostman('﻿' + fixture('dev.postman_environment.json'))
    expect(environmentOf(parsed).name).toBe('Dev')
  })
  it('rejects non-JSON with the parser message', () => {
    expect(() => parsePostman('{"info": ')).toThrow(/^Not valid JSON: .+/)
    expect(() => parsePostman('')).toThrow(/^Not valid JSON: /)
  })
  it('rejects JSON that is not an object', () => {
    for (const text of ['[]', '[{"info":{},"item":[]}]', 'null', '42', '"text"', 'true']) {
      expect(() => parsePostman(text)).toThrow(new Error('Not a Postman collection or environment file'))
    }
  })
  it('rejects a v1 collection (requests array, no info)', () => {
    expect(() => parsePostman(fixture('v1.postman_collection.json'))).toThrow(
      new Error(
        'Postman Collection v1 is not supported. Export it from Postman as Collection v2.1 and import that file.',
      ),
    )
  })
  it('rejects a data dump (version plus a collections array)', () => {
    expect(() => parsePostman(fixture('dump.json'))).toThrow(
      new Error(
        'This is a Postman data dump. Export the collections and environments one by one and import those files.',
      ),
    )
  })
  it('rejects anything else', () => {
    for (const value of [
      {},
      { name: 'x' },
      { values: [] },
      { name: 1, values: [] },
      { info: { name: 'x' } },
      { info: { name: 'x', schema: 'https://example.com/v3/collection.json' } },
      { info: 'x', item: [] },
      { item: [] },
    ]) {
      expect(() => parsePostman(JSON.stringify(value)), JSON.stringify(value)).toThrow(
        new Error('Not a Postman collection or environment file'),
      )
    }
  })
})

describe('parsePostman: collections', () => {
  it('keeps the collection name', () => {
    expect(fullCollection.name).toBe('Acme Orders API')
  })
  it('makes an item with an item array a folder (even if empty), otherwise a request, with default names', () => {
    expect(fullCollection.children.map((n) => (n.kind === 'folder' ? `folder ${n.name}` : n.request.name))).toEqual([
      'folder Customers',
      'folder Bodies',
      'New Request',
      'Key in cookie',
      'Key without location',
      'Open door',
      'folder New Folder',
    ])
    const empty = find(fullCollection.children, 'Bodies', 'Empty Folder')
    expect(empty).toEqual({ kind: 'folder', name: 'Empty Folder', children: [] })
    expect(find(fullCollection.children, 'Customers', 'Admin').kind).toBe('folder')
    const { collection } = parseItems([
      { name: '', item: [] },
      { name: '', request: {} },
    ])
    expect(collection.children).toEqual([
      { kind: 'folder', name: 'New Folder', children: [] },
      expect.objectContaining({ kind: 'request', request: expect.objectContaining({ name: 'New Request' }) }),
    ])
  })
  it('imports a request given as a string as a GET to that URL', () => {
    expect(fullRequest('Customers', 'Public', 'Health')).toEqual({
      name: 'Health',
      method: 'GET',
      url: 'https://status.example.com/health',
      params: [],
      headers: [],
      body: { mode: 'none' },
      auth: { type: 'none' },
    })
    expect(parseRequest('https://example.com/a?b=1').request).toMatchObject({
      method: 'GET',
      url: 'https://example.com/a',
      params: [{ key: 'b', value: '1', enabled: true }],
      auth: { type: 'inherit' },
    })
  })
  it('upper-cases the method and imports an unsupported method as GET with a warning', () => {
    expect(fullRequest('Customers', 'List customers').method).toBe('GET')
    expect(fullRequest('Customers', 'Admin', 'Delete customer').method).toBe('DELETE')
    expect(fullRequest('New Request').method).toBe('GET')
    expect(full.warnings).toContain('"New Request": method PURGE is not supported, imported as GET')
    for (const method of ['post', 'Put', 'PATCH', 'head', 'options']) {
      expect(parseRequest({ method, url: 'x' }).request.method).toBe(method.toUpperCase())
    }
    expect(parseRequest({ url: 'x' })).toMatchObject({ request: { method: 'GET' }, warnings: [] })
  })
  it('takes the url from a string or from an object (raw, or rebuilt), splitting the query', () => {
    expect(fullRequest('Customers', 'Create customer')).toMatchObject({ url: '{{base_url}}/customers', params: [] })
    expect(fullRequest('New Request')).toMatchObject({ url: 'https://api.example.com:8443/v1/ping', params: [] })
    expect(parseRequest({ url: { raw: 'https://example.com/a?x=1&y' } }).request).toMatchObject({
      url: 'https://example.com/a',
      params: [
        { key: 'x', value: '1', enabled: true },
        { key: 'y', value: '', enabled: true },
      ],
    })
    expect(parseRequest({ url: { host: '{{base}}', path: ['a', { type: 'string', value: 'b' }] } }).request.url).toBe(
      '{{base}}/a/b',
    )
    expect(parseRequest({ method: 'GET' }).request.url).toBe('')
  })
  it('takes params from the url query array, keeping disabled ones and values as written', () => {
    expect(fullRequest('Customers', 'List customers')).toMatchObject({
      url: '{{base_url}}/customers',
      params: [
        { key: 'page', value: '1', enabled: true },
        { key: 'limit', value: '20', enabled: true, description: 'Page size' },
        { key: 'debug', value: 'true', enabled: false },
        { key: 'name', value: 'J%C3%B6rg', enabled: true },
      ],
    })
    expect(
      parseRequest({ url: { raw: 'https://example.com/a?raw=1', query: [{ key: 'q', value: null }] } }).request,
    ).toMatchObject({ url: 'https://example.com/a', params: [{ key: 'q', value: '', enabled: true }] })
  })
  it('keeps the URL of a request with path variables and warns', () => {
    expect(fullRequest('Customers', 'Admin', 'Delete customer').url).toBe('{{base_url}}/customers/:id')
    expect(full.warnings).toContain(
      '"Delete customer": path variables are not supported; :name segments are left in the URL',
    )
    expect(parseRequest({ url: { raw: 'https://example.com/:id', variable: [] } }).warnings).toEqual([])
  })
  it('imports headers with enabled from disabled and a string or { content } description', () => {
    expect(fullRequest('Customers', 'List customers').headers).toEqual([
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Trace', value: 'on', enabled: false, description: 'Debug tracing' },
      { key: 'X-Client', value: 'astral', enabled: true, description: 'Who is calling' },
    ])
  })
  it('imports a raw body with its language (javascript and unknown become text)', () => {
    expect(fullRequest('Customers', 'Create customer').body).toEqual({
      mode: 'raw',
      language: 'json',
      content: '{\n  "name": "Jane Example"\n}',
    })
    expect(fullRequest('Bodies', 'Raw XML').body).toEqual({ mode: 'raw', language: 'xml', content: '<order id="7"/>' })
    expect(fullRequest('Bodies', 'Raw HTML').body).toEqual({ mode: 'raw', language: 'html', content: '<p>hi</p>' })
    expect(fullRequest('Bodies', 'Raw script').body).toEqual({ mode: 'raw', language: 'text', content: 'let a = 1' })
    expect(fullRequest('Bodies', 'Raw plain').body).toEqual({ mode: 'raw', language: 'text', content: 'hello' })
    const odd = { mode: 'raw', raw: 'x', options: { raw: { language: 'yaml' } } }
    expect(parseRequest({ body: odd }).request.body).toEqual({ mode: 'raw', language: 'text', content: 'x' })
    expect(parseRequest({ body: { mode: 'raw' } }).request.body).toEqual({ mode: 'raw', language: 'text', content: '' })
  })
  it('imports urlencoded and form-data fields, skipping file fields with a warning', () => {
    expect(fullRequest('Bodies', 'Login form').body).toEqual({
      mode: 'urlencoded',
      fields: [
        { key: 'user', value: 'jane', enabled: true },
        { key: 'remember', value: 'yes', enabled: false, description: 'Keep me signed in' },
      ],
    })
    expect(fullRequest('Bodies', 'Upload avatar').body).toEqual({
      mode: 'formdata',
      fields: [
        { key: 'title', value: 'Profile picture', enabled: true },
        { key: 'draft', value: '1', enabled: false },
      ],
    })
    expect(full.warnings).toContain('"Upload avatar": file field "avatar" was skipped')
  })
  it('imports a GraphQL body as raw JSON with parsed variables and warns', () => {
    expect(fullRequest('Bodies', 'Search orders').body).toEqual({
      mode: 'raw',
      language: 'json',
      content: JSON.stringify(
        { query: 'query ($q: String) { orders(q: $q) { id } }', variables: { q: 'red' } },
        null,
        2,
      ),
    })
    expect(full.warnings).toContain('"Search orders": GraphQL body imported as JSON')
    const graphql = (variables: unknown) =>
      parseRequest({ body: { mode: 'graphql', graphql: { query: '{ a }', variables } } }).request.body
    expect(graphql('not json')).toMatchObject({
      content: JSON.stringify({ query: '{ a }', variables: 'not json' }, null, 2),
    })
    expect(graphql({ a: 1 })).toMatchObject({
      content: JSON.stringify({ query: '{ a }', variables: { a: 1 } }, null, 2),
    })
    expect(graphql('')).toMatchObject({ content: JSON.stringify({ query: '{ a }' }, null, 2) })
  })
  it('imports file and other body modes as none with a warning', () => {
    expect(fullRequest('Bodies', 'Binary upload').body).toEqual({ mode: 'none' })
    expect(full.warnings).toContain('"Binary upload": file body is not supported')
    expect(parseRequest({ body: { mode: 'magic' } }, 'M')).toEqual({
      request: expect.objectContaining({ body: { mode: 'none' } }),
      warnings: ['"M": magic body is not supported'],
    })
    expect(parseRequest({ body: {} })).toMatchObject({ request: { body: { mode: 'none' } }, warnings: [] })
  })
  it('imports a request without auth as inherit', () => {
    expect(parseRequest({ url: 'x' }).request.auth).toEqual({ type: 'inherit' })
    expect(parseRequest({ url: 'x', auth: null }).request.auth).toEqual({ type: 'inherit' })
  })
  it('imports noauth as none', () => {
    expect(fullRequest('Open door').auth).toEqual({ type: 'none' })
  })
  it('imports bearer, basic and apikey from v2.1 arrays and v2.0 objects', () => {
    expect(fullCollection.auth).toEqual({ type: 'bearer', token: '{{token}}' })
    expect(fullRequest('Customers', 'Admin', 'Audit log').auth).toEqual({ type: 'bearer', token: 'audit-token' })
    expect(fullRequest('Customers', 'Create customer').auth).toEqual({
      type: 'basic',
      username: 'orders-bot',
      password: '{{bot_password}}',
    })
    expect(fullRequest('Customers', 'Admin', 'Delete customer').auth).toEqual({
      type: 'apikey',
      key: 'X-Admin-Key',
      value: '{{admin_key}}',
      in: 'query',
    })
    const legacy = collectionOf(parsePostman(fixture('legacy.v20.postman_collection.json')))
    expect(legacy.auth).toEqual({ type: 'bearer', token: '{{ship_token}}' })
    expect(requestAt(legacy.children, 'Depots', 'List depots').auth).toEqual({
      type: 'basic',
      username: 'depot',
      password: 's3cret',
    })
    expect(requestAt(legacy.children, 'Depots', 'Depot by key').auth).toEqual({
      type: 'apikey',
      key: 'X-Depot',
      value: '{{depot_key}}',
      in: 'header',
    })
    expect(requestAt(legacy.children, 'Track parcel')).toMatchObject({
      url: 'https://ship.example.com/track',
      params: [
        { key: 'code', value: 'AB12', enabled: true },
        { key: 'verbose', value: '', enabled: true },
      ],
      auth: { type: 'inherit' },
    })
    expect(parseRequest({ auth: { type: 'bearer' } }).request.auth).toEqual({ type: 'bearer', token: '' })
  })
  it('defaults apikey in to header, and treats any value other than query as header', () => {
    expect(fullRequest('Key without location').auth).toEqual({
      type: 'apikey',
      key: 'X-Api-Key',
      value: '{{api_key}}',
      in: 'header',
    })
    expect(fullRequest('Key in cookie').auth).toEqual({ type: 'apikey', key: 'session', value: 'abc', in: 'header' })
  })
  it('imports other auth types as none with a warning', () => {
    expect(fullRequest('New Request').auth).toEqual({ type: 'none' })
    expect(full.warnings).toContain('"New Request": oauth2 auth is not supported, imported as No Auth')
    const { collection, warnings } = parseItems([], { auth: { type: 'digest' } })
    expect(collection.auth).toEqual({ type: 'none' })
    expect(warnings).toEqual(['"T": digest auth is not supported, imported as No Auth'])
  })
  it('pushes folder auth into inheriting requests, with nested folder auth winning for its subtree', () => {
    const basic = { type: 'basic', username: 'orders-bot', password: '{{bot_password}}' }
    expect(fullRequest('Customers', 'List customers').auth).toEqual(basic)
    expect(fullRequest('Customers', 'Create customer').auth).toEqual(basic)
    expect(fullRequest('Customers', 'Admin', 'Delete customer').auth).toMatchObject({ type: 'apikey', in: 'query' })
    expect(fullRequest('Customers', 'Admin', 'Audit log').auth).toEqual({ type: 'bearer', token: 'audit-token' })
  })
  it('makes inheriting descendants of a noauth folder none', () => {
    expect(fullRequest('Customers', 'Public', 'Health').auth).toEqual({ type: 'none' })
  })
  it('keeps collection auth at the collection, leaving requests as inherit', () => {
    expect(fullCollection.auth).toEqual({ type: 'bearer', token: '{{token}}' })
    expect(fullRequest('Bodies', 'Raw XML').auth).toEqual({ type: 'inherit' })
    expect(parseItems([]).collection.auth).toEqual({ type: 'none' })
  })
  it('does not share one auth object between requests', () => {
    expect(fullRequest('Customers', 'List customers').auth).not.toBe(fullRequest('Customers', 'Create customer').auth)
  })
  it('maps prerequest and test events to scripts, ignoring disabled events', () => {
    expect(fullCollection.scripts).toEqual({
      preRequest: "console.log('collection pre')",
      postResponse: "console.log('collection post')",
    })
    const folder = find(fullCollection.children, 'Customers')
    expect(folder.kind === 'folder' && folder.scripts).toEqual({
      preRequest: "pm.variables.set('x', 1)\n// folder",
      postResponse: '',
    })
    expect(fullRequest('Customers', 'List customers').scripts).toEqual({
      preRequest: 'const page = 1',
      postResponse: "pm.test('ok', () => {\n  pm.response.to.have.status(200)\n})",
    })
  })
  it('sets scripts only when at least one is non-empty', () => {
    expect(fullRequest('Customers', 'Create customer')).not.toHaveProperty('scripts')
    expect(find(fullCollection.children, 'Bodies')).not.toHaveProperty('scripts')
    const events = [
      { listen: 'prerequest', script: { exec: [] } },
      { listen: 'test', script: { exec: '' } },
      { listen: 'test', disabled: true, script: { exec: ['x'] } },
    ]
    expect(parseItems([{ name: 'R', event: events, request: {} }]).collection.children[0]).not.toHaveProperty(
      'request.scripts',
    )
    expect(parseItems([], { event: events }).collection).not.toHaveProperty('scripts')
  })
  it('imports collection variables with value as a string and enabled from disabled', () => {
    expect(fullCollection.variables).toEqual([
      { key: 'base_url', value: 'https://api.example.com', enabled: true },
      { key: 'api_version', value: 'v2', enabled: false },
      { key: 'retries', value: '3', enabled: true },
      { key: 'empty', value: '', enabled: true },
    ])
  })
  it('drops saved example responses with one warning per collection', () => {
    expect(full.warnings.filter((w) => w.includes('example'))).toEqual(['3 saved example responses were not imported'])
    expect(fullRequest('Customers', 'List customers')).not.toHaveProperty('response')
    const one = parseItems([{ name: 'R', request: {}, response: [{ name: 'ok' }] }])
    expect(one.warnings).toEqual(['1 saved example response was not imported'])
  })
  it('drops descriptions of requests, folders and the collection and protocolProfileBehavior silently', () => {
    expect(fullCollection).not.toHaveProperty('description')
    expect(find(fullCollection.children, 'Customers')).not.toHaveProperty('description')
    expect(Object.keys(fullRequest('Customers', 'List customers')).sort()).toEqual(
      ['auth', 'body', 'headers', 'method', 'name', 'params', 'scripts', 'url'].sort(),
    )
    expect(full.warnings.some((w) => /description|protocolProfileBehavior/.test(w))).toBe(false)
  })
  it('collects exactly the expected warnings for the full fixture, in item order', () => {
    expect(full.warnings).toEqual([
      '"Delete customer": path variables are not supported; :name segments are left in the URL',
      '"Upload avatar": file field "avatar" was skipped',
      '"Search orders": GraphQL body imported as JSON',
      '"Binary upload": file body is not supported',
      '"New Request": method PURGE is not supported, imported as GET',
      '"New Request": oauth2 auth is not supported, imported as No Auth',
      '3 saved example responses were not imported',
    ])
  })
})

describe('parsePostman: environments', () => {
  const dev = parsePostman(fixture('dev.postman_environment.json'))
  it('imports secret values as current values with an empty initial value', () => {
    const vars = environmentOf(dev).variables
    expect(vars.find((v) => v.key === 'token')).toEqual({
      key: 'token',
      value: '',
      currentValue: 'dev-token-123',
      secret: true,
      enabled: true,
    })
    expect(vars.find((v) => v.key === 'empty_secret')).toEqual({
      key: 'empty_secret',
      value: '',
      secret: true,
      enabled: true,
    })
    const globals = environmentOf(parsePostman(fixture('workspace.postman_globals.json')))
    expect(globals.variables).toEqual([
      { key: 'tenant', value: 'acme', secret: false, enabled: true },
      { key: 'signing_key', value: '', currentValue: 'k-987', secret: true, enabled: false },
    ])
  })
  it('imports other values as plain variables, enabled unless enabled is false', () => {
    expect(environmentOf(dev).variables).toEqual([
      { key: 'base_url', value: 'https://dev.example.com', secret: false, enabled: true },
      { key: 'token', value: '', currentValue: 'dev-token-123', secret: true, enabled: true },
      { key: 'empty_secret', value: '', secret: true, enabled: true },
      { key: 'old_host', value: 'https://legacy.example.com', secret: false, enabled: false },
      { key: 'timeout', value: '30', secret: false, enabled: true },
    ])
    expect(dev.warnings).toEqual([])
  })
})
