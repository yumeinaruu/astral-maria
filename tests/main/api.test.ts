import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApi, type ApiDeps } from '../../src/main/api'
import { OperationTracker } from '../../src/main/flushGuard'
import { API_METHODS, CHANNELS, channelName, unwrapIpcError, type AstralApi } from '../../src/shared/api'
import type { Environment, RequestItem, RunEvent, RunOptions } from '../../src/shared/types'

const cipher = {
  encrypt: (s: string) => `x:${s}`,
  decrypt: (s: string) => s.replace(/^x:/, ''),
}

let tmp: string
let server: Server
let base: string
let seen: IncomingMessage[]
let slowResponses: (() => void)[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astral-api-'))
  seen = []
  slowResponses = []
  server = createServer((req, res) => {
    seen.push(req)
    if (req.url?.startsWith('/slow')) {
      slowResponses.push(() => res.end('late'))
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ url: req.url, auth: req.headers.authorization ?? null }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const finish of slowResponses) finish()
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  await fs.rm(tmp, { recursive: true, force: true })
})

const noDialogs = {
  pickImportFiles: async (): Promise<string[]> => [],
  pickExportPath: async (): Promise<string | null> => null,
}

function makeApi(pick: () => Promise<string | null> = async () => null, over: Partial<ApiDeps> = {}): AstralApi {
  return createApi({ cipher, pickDirectory: pick, recentFile: path.join(tmp, 'recent.json'), ...noDialogs, ...over })
}

async function newWorkspace(api: AstralApi, name = 'ws'): Promise<string> {
  const dir = path.join(tmp, name)
  await api.workspace.create(dir, name)
  return dir
}

function env(id: string, vars: Record<string, string>): Environment {
  return {
    id,
    name: id,
    variables: Object.entries(vars).map(([key, value]) => ({ key, value, secret: false, enabled: true })),
  }
}

function req(over: Partial<RequestItem> = {}): RequestItem {
  return {
    id: 'r1',
    name: 'r',
    method: 'GET',
    url: '{{baseUrl}}/hello',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...over,
  }
}

async function body(
  result: Awaited<ReturnType<AstralApi['http']['send']>>,
): Promise<{ url: string; auth: string | null }> {
  if (!result.ok) throw new Error(`send failed: ${result.error.message}`)
  return JSON.parse(Buffer.from(result.response.bodyBase64, 'base64').toString('utf8'))
}

describe('workspace guard', () => {
  it('rejects every workspace-bound method with no_workspace_open', async () => {
    const api = makeApi()
    await expect(api.collections.list()).rejects.toThrow('no_workspace_open')
    await expect(api.collections.createCollection('c')).rejects.toThrow('no_workspace_open')
    await expect(api.environments.list()).rejects.toThrow('no_workspace_open')
    await expect(api.transfer.importFiles()).rejects.toThrow('no_workspace_open')
    await expect(api.transfer.importText('{}', 'x')).rejects.toThrow('no_workspace_open')
    await expect(api.transfer.exportCollection('collections/c')).rejects.toThrow('no_workspace_open')
    await expect(api.transfer.exportEnvironment('e')).rejects.toThrow('no_workspace_open')
    await expect(api.http.send(req(), { collectionPath: null, environmentId: null }, 's')).rejects.toThrow(
      'no_workspace_open',
    )
  })

  it('rejects with a clear message when the workspace folder was deleted', async () => {
    const api = makeApi()
    const dir = await newWorkspace(api)
    await fs.rm(dir, { recursive: true, force: true })
    await expect(api.collections.list()).rejects.toThrow(/workspace/i)
    await expect(api.environments.list()).rejects.toThrow(/workspace/i)
  })
})

describe('collections end to end', () => {
  it('creates a collection and request, saves it and lists it back', async () => {
    const api = makeApi()
    await newWorkspace(api)
    const c = await api.collections.createCollection('My API')
    const r = await api.collections.createRequest(c.path, 'Get users')
    await api.collections.saveRequest(r.path, { ...r.request, url: 'https://example.test/users', method: 'POST' })
    const { collections, errors } = await api.collections.list()
    expect(errors).toEqual([])
    const node = collections[0].children[0]
    expect(node.kind === 'request' && node.request.url).toBe('https://example.test/users')
    expect(node.kind === 'request' && node.request.method).toBe('POST')
  })

  it('passes the expected revision through and returns the new one', async () => {
    const api = makeApi()
    const dir = await newWorkspace(api)
    const c = await api.collections.createCollection('C')
    const r = await api.collections.createRequest(c.path, 'R')
    const next = await api.collections.saveRequest(r.path, { ...r.request, url: 'one' }, r.revision)
    const node = (await api.collections.list()).collections[0].children[0]
    expect(node.kind === 'request' && node.revision).toBe(next)
    await fs.writeFile(path.join(dir, r.path), JSON.stringify({ ...r.request, url: 'edited elsewhere' }))
    await expect(api.collections.saveRequest(r.path, { ...r.request, url: 'two' }, next)).rejects.toThrow(
      'changed_on_disk',
    )
  })

  it('stores environments through the same workspace', async () => {
    const api = makeApi()
    await newWorkspace(api)
    await api.environments.save(env('e1', { a: '1' }))
    expect((await api.environments.list()).environments.map((e) => e.id)).toEqual(['e1'])
    await api.environments.remove('e1')
    expect((await api.environments.list()).environments).toEqual([])
  })

  it('opening another workspace replaces the previous one', async () => {
    const api = makeApi()
    await newWorkspace(api, 'one')
    await api.collections.createCollection('only-in-one')
    await newWorkspace(api, 'two')
    expect((await api.collections.list()).collections).toEqual([])
    await api.workspace.open(path.join(tmp, 'one'))
    expect((await api.collections.list()).collections).toHaveLength(1)
  })
})

describe('http.send', () => {
  it('substitutes variables from the selected environment', async () => {
    const api = makeApi()
    await newWorkspace(api)
    await api.environments.save(env('e1', { baseUrl: base }))
    const result = await api.http.send(req(), { collectionPath: null, environmentId: 'e1' }, 's')
    expect((await body(result)).url).toBe('/hello')
  })

  it('prefers environment over collection variable over global', async () => {
    const api = makeApi()
    await newWorkspace(api)
    const c = await api.collections.createCollection('c')
    // Collection variables have no API method, so write the collection file directly.
    const metaFile = path.join(tmp, 'ws', c.path, 'collection.json')
    const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'))
    meta.variables = [
      { key: 'p', value: 'fromCollection', enabled: true },
      { key: 'q', value: 'fromCollection', enabled: true },
      { key: 'off', value: 'fromCollection', enabled: false },
    ]
    await fs.writeFile(metaFile, JSON.stringify(meta))
    await api.environments.save(
      env('globals', { p: 'fromGlobal', q: 'fromGlobal', r: 'fromGlobal', off: 'fromGlobal' }),
    )
    await api.environments.save(env('e1', { p: 'fromEnv' }))

    const request = req({ url: `${base}/{{p}}/{{q}}/{{r}}/{{off}}` })
    const result = await api.http.send(
      request,
      { collectionPath: `${c.path}/some/request.json`, environmentId: 'e1' },
      's',
    )
    expect((await body(result)).url).toBe('/fromEnv/fromCollection/fromGlobal/fromGlobal')
  })

  it('uses the collection bearer token for inherit auth', async () => {
    const api = makeApi()
    await newWorkspace(api)
    const c = await api.collections.createCollection('c')
    const metaFile = path.join(tmp, 'ws', c.path, 'collection.json')
    const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'))
    meta.auth = { type: 'bearer', token: '{{tok}}' }
    await fs.writeFile(metaFile, JSON.stringify(meta))
    await api.environments.save(env('e1', { tok: 'abc' }))
    const request = req({ url: `${base}/x`, auth: { type: 'inherit' } })
    const result = await api.http.send(
      request,
      { collectionPath: `${c.path}/r.request.json`, environmentId: 'e1' },
      's',
    )
    expect((await body(result)).auth).toBe('Bearer abc')
  })

  it('sends inherit auth without credentials when the collection has none', async () => {
    const api = makeApi()
    await newWorkspace(api)
    const c = await api.collections.createCollection('c')
    const request = req({ url: `${base}/x`, auth: { type: 'inherit' } })
    const result = await api.http.send(
      request,
      { collectionPath: `${c.path}/r.request.json`, environmentId: null },
      's',
    )
    expect((await body(result)).auth).toBeNull()
  })

  it('still sends when the selected environment no longer exists', async () => {
    const api = makeApi()
    await newWorkspace(api)
    const result = await api.http.send(
      req({ url: `${base}/ok` }),
      { collectionPath: null, environmentId: 'deleted' },
      's',
    )
    expect((await body(result)).url).toBe('/ok')
  })

  it('returns network failures as results, not rejections', async () => {
    const api = makeApi()
    await newWorkspace(api)
    const result = await api.http.send(
      req({ url: 'http://127.0.0.1:1/' }),
      {
        collectionPath: null,
        environmentId: null,
      },
      's',
    )
    expect(result.ok).toBe(false)
  })

  it('cancel(id) makes that in-flight send resolve to cancelled', async () => {
    const api = makeApi()
    await newWorkspace(api)
    const pending = api.http.send(req({ url: `${base}/slow` }), { collectionPath: null, environmentId: null }, 'a')
    await waitFor(() => seen.length === 1)
    await api.http.cancel('a')
    const result = await pending
    expect(!result.ok && result.error.code).toBe('cancelled')
  })

  it('runs parallel sends independently', async () => {
    const api = makeApi()
    await newWorkspace(api)
    const first = api.http.send(req({ url: `${base}/slow` }), { collectionPath: null, environmentId: null }, 'a')
    await waitFor(() => seen.length === 1)
    const second = await api.http.send(req({ url: `${base}/fast` }), { collectionPath: null, environmentId: null }, 'b')
    expect((await body(second)).url).toBe('/fast')
    for (const finish of slowResponses) finish()
    const late = await first
    expect(late.ok && Buffer.from(late.response.bodyBase64, 'base64').toString()).toBe('late')
  })

  it('cancel(A) leaves B running, and an unknown id is a no-op', async () => {
    const api = makeApi()
    await newWorkspace(api)
    const a = api.http.send(req({ url: `${base}/slow/a` }), { collectionPath: null, environmentId: null }, 'a')
    const b = api.http.send(req({ url: `${base}/slow/b` }), { collectionPath: null, environmentId: null }, 'b')
    await waitFor(() => seen.length === 2)
    await api.http.cancel('unknown')
    await api.http.cancel('a')
    expect(await a).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    for (const finish of slowResponses) finish()
    expect(await b).toMatchObject({ ok: true })
    // Cancelling a send that already finished does nothing either.
    await expect(api.http.cancel('a')).resolves.toBeUndefined()
  })

  it('rejects a send id that is not a non-empty string', async () => {
    const api = makeApi()
    await newWorkspace(api)
    const ctx = { collectionPath: null, environmentId: null }
    await expect(api.http.send(req({ url: `${base}/x` }), ctx, '' as string)).rejects.toThrow('invalid_send_id')
    await expect(api.http.send(req({ url: `${base}/x` }), ctx, 5 as unknown as string)).rejects.toThrow(
      'invalid_send_id',
    )
  })

  it('cancels all in-flight sends when another workspace is opened', async () => {
    const api = makeApi()
    await newWorkspace(api, 'one')
    const a = api.http.send(req({ url: `${base}/slow` }), { collectionPath: null, environmentId: null }, 'a')
    const b = api.http.send(req({ url: `${base}/slow` }), { collectionPath: null, environmentId: null }, 'b')
    await waitFor(() => seen.length === 2)
    await newWorkspace(api, 'two')
    for (const result of await Promise.all([a, b])) expect(!result.ok && result.error.code).toBe('cancelled')
  })
})

async function waitFor(cond: () => boolean): Promise<void> {
  const until = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('workspace.recent', () => {
  it('lists the most recent workspace first, de-duplicated', async () => {
    const api = makeApi()
    const a = await newWorkspace(api, 'a')
    const b = await newWorkspace(api, 'b')
    await api.workspace.open(a)
    expect((await api.workspace.recent()).map((w) => w.dir)).toEqual([a, b])
  })

  it('caps at 10 entries', async () => {
    const api = makeApi()
    for (let i = 0; i < 12; i++) await newWorkspace(api, `w${i}`)
    const recent = await api.workspace.recent()
    expect(recent).toHaveLength(10)
    expect(recent[0].name).toBe('w11')
  })

  it('persists across api instances and omits workspaces that are gone', async () => {
    const first = makeApi()
    const a = await newWorkspace(first, 'a')
    const b = await newWorkspace(first, 'b')
    await fs.rm(a, { recursive: true, force: true })
    expect((await makeApi().workspace.recent()).map((w) => w.dir)).toEqual([b])
  })

  it('leaves the files of listed workspaces byte-identical', async () => {
    const api = makeApi()
    const dirs = [await newWorkspace(api, 'a'), await newWorkspace(api, 'b')]
    const snapshot = async () => {
      const out: Record<string, string> = {}
      for (const d of dirs) {
        for (const name of await fs.readdir(d)) {
          const p = path.join(d, name)
          if ((await fs.stat(p)).isFile()) out[p] = await fs.readFile(p, 'utf8')
        }
      }
      return out
    }
    // A repository whose .gitignore does not list .local/ yet, and one without a .gitignore at all.
    await fs.writeFile(path.join(dirs[0], '.gitignore'), 'node_modules/')
    await fs.rm(path.join(dirs[1], '.gitignore'))
    const before = await snapshot()
    expect((await makeApi().workspace.recent()).map((w) => w.dir)).toEqual([dirs[1], dirs[0]])
    expect(await snapshot()).toEqual(before)
  })

  it('treats a corrupt recent file as empty', async () => {
    await fs.writeFile(path.join(tmp, 'recent.json'), '{nope')
    expect(await makeApi().workspace.recent()).toEqual([])
    await fs.writeFile(path.join(tmp, 'recent.json'), JSON.stringify([{ dir: 5 }]))
    expect(await makeApi().workspace.recent()).toEqual([])
  })

  it('still opens a workspace when the recent file cannot be written', async () => {
    const api = createApi({
      cipher,
      ...noDialogs,
      pickDirectory: async () => null,
      recentFile: path.join(tmp, 'missing', 'dir', 'r.json'),
    })
    await expect(api.workspace.create(path.join(tmp, 'w'), 'w')).resolves.toMatchObject({ name: 'w' })
  })
})

describe('collections.updateSettings', () => {
  it('saves collection and folder settings; a folder takes only scripts', async () => {
    const api = makeApi()
    await newWorkspace(api)
    const col = await api.collections.createCollection('Shop')
    const folder = await api.collections.createFolder(col.path, 'Users')
    const scripts = { preRequest: 'a()', postResponse: 'b()' }
    await api.collections.updateSettings(col.path, {
      scripts,
      variables: [{ key: 'v', value: '1', enabled: true }],
      auth: { type: 'bearer', token: 't' },
    })
    await api.collections.updateSettings(folder.path, { scripts })
    await expect(api.collections.updateSettings(folder.path, { variables: [] })).rejects.toThrow('not_a_collection')
    const [tree] = (await api.collections.list()).collections
    expect(tree).toMatchObject({ scripts, variables: [{ key: 'v' }], auth: { type: 'bearer', token: 't' } })
    expect(tree.children[0]).toMatchObject({ kind: 'folder', scripts })
  })

  it('needs an open workspace', async () => {
    await expect(makeApi().collections.updateSettings('collections/x', {})).rejects.toThrow('no_workspace_open')
  })
})

describe('workspace.close', () => {
  it('cancels sends in flight and leaves no workspace open, which can be opened again', async () => {
    const api = makeApi()
    const dir = await newWorkspace(api)
    const pending = api.http.send(req({ url: `${base}/slow` }), { collectionPath: null, environmentId: null }, 'a')
    await waitFor(() => seen.length === 1)
    await api.workspace.close()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    await expect(api.collections.list()).rejects.toThrow('no_workspace_open')
    expect((await api.workspace.recent()).map((w) => w.dir)).toEqual([dir])
    await api.workspace.open(dir)
    await expect(api.collections.list()).resolves.toMatchObject({ errors: [] })
  })

  it('is harmless when no workspace is open', async () => {
    await expect(makeApi().workspace.close()).resolves.toBeUndefined()
  })
})

describe('quit support', () => {
  it('app.flushed reports the acknowledgement to main', async () => {
    let acks = 0
    const api = createApi({
      cipher,
      ...noDialogs,
      pickDirectory: async () => null,
      recentFile: path.join(tmp, 'recent.json'),
      onFlushed: () => acks++,
    })
    await api.app.flushed()
    expect(acks).toBe(1)
  })

  it('tracks store operations so a quit can wait for them', async () => {
    const operations = new OperationTracker()
    const api = createApi({
      cipher,
      ...noDialogs,
      pickDirectory: async () => null,
      recentFile: path.join(tmp, 'recent.json'),
      operations,
    })
    await newWorkspace(api)
    const c = await api.collections.createCollection('C')
    const r = await api.collections.createRequest(c.path, 'R')
    const order: string[] = []
    const saving = api.collections
      .saveRequest(r.path, { ...r.request, url: 'during quit' })
      .then(() => order.push('save'))
    const envSaving = api.environments.save(env('e1', { a: '1' })).then(() => order.push('env'))
    const waiting = operations.idle().then(() => order.push('idle'))
    await Promise.all([saving, envSaving, waiting])
    expect(order.indexOf('idle')).toBe(2)
    const node = (await api.collections.list()).collections[0].children[0]
    expect(node.kind === 'request' && node.request.url).toBe('during quit')
  })
})

describe('workspace.pickDirectory', () => {
  it('delegates to the injected picker', async () => {
    expect(await makeApi(async () => '/some/dir').workspace.pickDirectory()).toBe('/some/dir')
  })
})

describe('transfer', () => {
  const fixturePath = (name: string) => path.resolve(__dirname, '../fixtures/postman', name)

  it('importFiles imports the picked files in order into the open workspace', async () => {
    const api = makeApi(undefined, {
      pickImportFiles: async () => [
        fixturePath('full.v21.postman_collection.json'),
        fixturePath('dev.postman_environment.json'),
      ],
    })
    await newWorkspace(api)
    const report = await api.transfer.importFiles()
    expect(report?.failed).toEqual([])
    expect(report?.imported.map((i) => i.kind)).toEqual(['collection', 'environment'])
    expect((await api.collections.list()).collections).toHaveLength(1)
    expect((await api.environments.list()).environments.map((e) => e.name)).toEqual(['Dev'])
  })

  it('importFiles resolves null when the dialog is cancelled', async () => {
    const api = makeApi()
    await newWorkspace(api)
    expect(await api.transfer.importFiles()).toBeNull()
  })

  it('importText imports into the open workspace', async () => {
    const api = makeApi()
    await newWorkspace(api)
    const text = await fs.readFile(fixturePath('workspace.postman_globals.json'), 'utf8')
    const report = await api.transfer.importText(text, 'Pasted text')
    expect(report.imported).toMatchObject([{ source: 'Pasted text', kind: 'globals' }])
    expect((await api.environments.list()).environments.map((e) => e.id)).toEqual(['globals'])
  })

  it('importText rejects a non-string text or source', async () => {
    const api = makeApi()
    await newWorkspace(api)
    await expect(api.transfer.importText(5 as unknown as string, 'x')).rejects.toThrow('invalid_argument')
    await expect(api.transfer.importText('{}', null as unknown as string)).rejects.toThrow('invalid_argument')
  })

  it('exports through the save dialog with the suggested file name', async () => {
    const asked: string[] = []
    const out = path.join(tmp, 'out')
    await fs.mkdir(out)
    const api = makeApi(undefined, {
      pickExportPath: async (name) => {
        asked.push(name)
        return path.join(out, name)
      },
    })
    await newWorkspace(api)
    const c = await api.collections.createCollection('Shop')
    await api.environments.save(env('e1', { a: '1' }))
    expect(await api.transfer.exportCollection(c.path)).toBe(path.join(out, 'Shop.postman_collection.json'))
    expect(await api.transfer.exportEnvironment('e1')).toBe(path.join(out, 'e1.postman_environment.json'))
    expect(asked).toEqual(['Shop.postman_collection.json', 'e1.postman_environment.json'])
    expect(JSON.parse(await fs.readFile(path.join(out, 'Shop.postman_collection.json'), 'utf8')).info.name).toBe('Shop')
    await expect(api.transfer.exportCollection('collections/nope')).rejects.toThrow('collection_not_found')
    await expect(api.transfer.exportEnvironment('nope')).rejects.toThrow('environment_not_found')
  })

  it('tracks imports so a quit can wait for them', async () => {
    const operations = new OperationTracker()
    const api = createApi({
      cipher,
      ...noDialogs,
      pickDirectory: async () => null,
      recentFile: path.join(tmp, 'recent.json'),
      operations,
    })
    await newWorkspace(api)
    const text = await fs.readFile(fixturePath('full.v21.postman_collection.json'), 'utf8')
    const order: string[] = []
    const importing = api.transfer.importText(text, 'x').then(() => order.push('import'))
    const waiting = operations.idle().then(() => order.push('idle'))
    await Promise.all([importing, waiting])
    expect(order).toEqual(['import', 'idle'])
  })
})

describe('runner', () => {
  function runnerApi(over: Partial<ApiDeps> = {}) {
    const events: RunEvent[] = []
    const api = makeApi(undefined, { emitRunEvent: (e) => events.push(e), ...over })
    const finished = () => waitFor(() => events.some((e) => e.type === 'finished'))
    return { api, events, finished }
  }

  async function savedRequest(api: AstralApi, parent: string, name: string, over: Partial<RequestItem>) {
    const node = await api.collections.createRequest(parent, name)
    await api.collections.saveRequest(node.path, { ...node.request, ...over })
    return node.path
  }

  const runOptions = (over: Partial<RunOptions> & Pick<RunOptions, 'path' | 'requestPaths'>): RunOptions => ({
    environmentId: null,
    iterations: 1,
    delayMs: 0,
    data: null,
    keepVariables: true,
    stopOnError: false,
    ...over,
  })

  it('start drives real sends, resolving data values on the plain path, and emits the events in order', async () => {
    const { api, events, finished } = runnerApi()
    await newWorkspace(api)
    await api.environments.save(env('e1', { baseUrl: base, user: 'fromEnv' }))
    const c = await api.collections.createCollection('Shop')
    const one = await savedRequest(api, c.path, 'One', { url: '{{baseUrl}}/one/{{user}}' })
    const two = await savedRequest(api, c.path, 'Two', { url: '{{baseUrl}}/two', method: 'POST' })
    const runId = await api.runner.start(
      runOptions({
        path: c.path,
        requestPaths: [one, two],
        environmentId: 'e1',
        iterations: 2,
        data: { name: 'users.csv', rows: [{ user: 'ann' }, { user: { id: 7 } }] },
      }),
    )
    await finished()
    expect(seen.map((r) => r.url)).toEqual(['/one/ann', '/two', '/one/%7B%22id%22:7%7D', '/two'])
    expect(events.map((e) => e.type)).toEqual(['started', 'result', 'result', 'result', 'result', 'finished'])
    expect(events.every((e) => e.runId === runId)).toBe(true)
    expect(events[0]).toMatchObject({ type: 'started', total: 4 })
    expect(events[1]).toMatchObject({
      type: 'result',
      result: { iteration: 0, path: one, name: 'One', method: 'GET', url: `${base}/one/ann`, status: 200 },
    })
    expect(events[2]).toMatchObject({ result: { iteration: 0, name: 'Two', method: 'POST' } })
    expect(events[3]).toMatchObject({ result: { iteration: 1, name: 'One' } })
    expect(events.at(-1)).toMatchObject({ type: 'finished', reason: 'completed' })
  })

  it('masks secret values in the reported URL', async () => {
    const { api, events, finished } = runnerApi()
    await newWorkspace(api)
    await api.environments.save({
      id: 'e1',
      name: 'e1',
      variables: [{ key: 'key', value: '', currentValue: 'supersecret', secret: true, enabled: true }],
    })
    const c = await api.collections.createCollection('Shop')
    const r = await savedRequest(api, c.path, 'R', {
      url: `${base}/m`,
      params: [{ key: 'k', value: '{{key}}', enabled: true }],
    })
    await api.runner.start(runOptions({ path: c.path, requestPaths: [r], environmentId: 'e1' }))
    await finished()
    expect(seen[0].url).toBe('/m?k=supersecret')
    const result = events.find((e) => e.type === 'result')
    expect(result?.type === 'result' && result.result.url).toBe(`${base}/m?k=••••`)
  })

  it('stop(id) of an unknown run is a no-op, and the methods need an open workspace', async () => {
    const { api } = runnerApi()
    const options = runOptions({ path: 'collections/c', requestPaths: ['collections/c/r'] })
    await expect(api.runner.start(options)).rejects.toThrow('no_workspace_open')
    await expect(api.runner.saveReport('{}', 'r.json')).rejects.toThrow('no_workspace_open')
    await api.runner.stop('nope')
  })

  describe('pickDataFile', () => {
    async function pick(name: string, content: string | null) {
      const file = path.join(tmp, name)
      if (content !== null) await fs.writeFile(file, content)
      const { api } = runnerApi({ pickDataFile: async () => file })
      return api.runner.pickDataFile()
    }

    it('parses a CSV or JSON file by its extension', async () => {
      expect(await pick('users.csv', 'name,age\nann,3\n')).toEqual({
        name: 'users.csv',
        rows: [{ name: 'ann', age: '3' }],
      })
      expect(await pick('users.JSON', '[{"age":3}]')).toEqual({ name: 'users.JSON', rows: [{ age: 3 }] })
    })

    it('resolves null when the dialog is cancelled', async () => {
      const { api } = runnerApi({ pickDataFile: async () => null })
      expect(await api.runner.pickDataFile()).toBeNull()
    })

    it('rejects with the parse message, another extension and a file over 10 MB', async () => {
      await expect(pick('empty.csv', '')).rejects.toThrow('The data file has no rows')
      await expect(pick('data.txt', 'a\n1')).rejects.toThrow('The data file must be a .csv or .json file')
      const big = path.join(tmp, 'big.csv')
      await fs.writeFile(big, 'a\n1\n')
      await fs.truncate(big, 10 * 1024 * 1024 + 1)
      await expect(pick('big.csv', null)).rejects.toThrow('The data file is larger than 10 MB')
    })
  })

  describe('saveReport', () => {
    it('writes the report where the save dialog says', async () => {
      const asked: string[] = []
      const target = path.join(tmp, 'report.json')
      const { api } = runnerApi({
        pickExportPath: async (name) => {
          asked.push(name)
          return target
        },
      })
      await newWorkspace(api)
      expect(await api.runner.saveReport('{"ok":true}', 'Shop.run.json')).toBe(target)
      expect(asked).toEqual(['Shop.run.json'])
      expect(await fs.readFile(target, 'utf8')).toBe('{"ok":true}')
    })

    it('resolves null when cancelled and rejects non-string arguments', async () => {
      const { api } = runnerApi()
      await newWorkspace(api)
      expect(await api.runner.saveReport('{}', 'r.json')).toBeNull()
      await expect(api.runner.saveReport(5 as unknown as string, 'r.json')).rejects.toThrow('invalid_argument')
    })
  })
})

describe('API surface', () => {
  it('CHANNELS match the methods createApi implements', () => {
    const api = makeApi()
    const implemented = Object.entries(api).flatMap(([g, methods]) =>
      Object.keys(methods as object).map((m) => channelName(g, m)),
    )
    expect([...CHANNELS].sort()).toEqual(implemented.sort())
    expect(Object.keys(API_METHODS).sort()).toEqual(Object.keys(api).sort())
  })

  it('unwrapIpcError strips the Electron prefix', () => {
    const raw = new Error("Error invoking remote method 'astral:collections.list': Error: no_workspace_open")
    expect(unwrapIpcError(raw).message).toBe('no_workspace_open')
    expect(unwrapIpcError(new Error('plain')).message).toBe('plain')
  })
})
