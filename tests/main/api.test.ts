import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApi } from '../../src/main/api'
import { API_METHODS, CHANNELS, channelName, unwrapIpcError, type AstralApi } from '../../src/shared/api'
import type { Environment, RequestItem } from '../../src/shared/types'

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

function makeApi(pick: () => Promise<string | null> = async () => null): AstralApi {
  return createApi({ cipher, pickDirectory: pick, recentFile: path.join(tmp, 'recent.json') })
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
      pickDirectory: async () => null,
      recentFile: path.join(tmp, 'missing', 'dir', 'r.json'),
    })
    await expect(api.workspace.create(path.join(tmp, 'w'), 'w')).resolves.toMatchObject({ name: 'w' })
  })
})

describe('workspace.pickDirectory', () => {
  it('delegates to the injected picker', async () => {
    expect(await makeApi(async () => '/some/dir').workspace.pickDirectory()).toBe('/some/dir')
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
