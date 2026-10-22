import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApi } from '../../src/main/api'
import { runScript } from '../../src/main/scripts/engine'
import { sendRequest } from '../../src/main/http/sendRequest'
import { runWithScripts, type PipelineRun, type ScriptRunner } from '../../src/main/scripts/pipeline'
import type { AstralApi } from '../../src/shared/api'
import type { Environment, RequestItem, ScriptReport, SendResult } from '../../src/shared/types'

// The send pipeline end to end: createApi with a fake ScriptHost that runs the real engine in this process, and a
// local HTTP server as the target.

const cipher = {
  encrypt: (s: string) => `x:${s}`,
  decrypt: (s: string) => s.replace(/^x:/, ''),
}

let tmp: string
let dir: string
let server: Server
let base: string
let seen: IncomingMessage[]
let host: ScriptRunner & { run: ReturnType<typeof vi.fn> }
let api: AstralApi

const LIMITS = { cpuMs: 300, wallMs: 3000, memoryBytes: 64 * 1024 * 1024 }

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astral-pipeline-'))
  seen = []
  server = createServer((req, res) => {
    seen.push(req)
    if (req.url?.startsWith('/html')) {
      res.setHeader('content-type', 'text/html')
      res.end('<html>not json</html>')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ url: req.url, method: req.method, trail: req.headers['x-trail'] ?? null }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  host = { run: vi.fn((prelude, source, input, hooks, opts) => runScript(prelude, source, input, hooks, opts)) }
  api = createApi({
    cipher,
    pickDirectory: async () => null,
    pickImportFiles: async () => [],
    pickExportPath: async () => null,
    recentFile: path.join(tmp, 'recent.json'),
    scriptHost: host,
    scriptLimits: LIMITS,
  })
  dir = path.join(tmp, 'ws')
  await api.workspace.create(dir, 'ws')
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  await fs.rm(tmp, { recursive: true, force: true })
})

const scripts = (preRequest = '', postResponse = '') => ({ preRequest, postResponse })

function req(over: Partial<RequestItem> = {}): RequestItem {
  return {
    id: 'r1',
    name: 'Get',
    method: 'GET',
    url: `${base}/hello`,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...over,
  }
}

/** A collection "Shop" with a folder "Users" holding a request "Get". */
async function tree() {
  const col = await api.collections.createCollection('Shop')
  const folder = await api.collections.createFolder(col.path, 'Users')
  const node = await api.collections.createRequest(folder.path, 'Get')
  return { col: col.path, folder: folder.path, request: node.path }
}

interface Ctx {
  collectionPath?: string | null
  requestPath?: string
  environmentId?: string | null
}

function send(request: RequestItem, ctx: Ctx = {}, id = 's1') {
  return api.http.send(
    request,
    {
      collectionPath: ctx.collectionPath ?? null,
      environmentId: ctx.environmentId ?? null,
      requestPath: ctx.requestPath,
    },
    id,
  )
}

function report(result: SendResult): ScriptReport {
  if (!result.scripts) throw new Error('no script report')
  return result.scripts
}

function json(result: SendResult): Record<string, unknown> {
  if (!result.ok) throw new Error(`send failed: ${result.error.message}`)
  return JSON.parse(Buffer.from(result.response.bodyBase64, 'base64').toString('utf8'))
}

async function saveEnv(env: Environment): Promise<void> {
  await api.environments.save(env)
}

describe('order and state', () => {
  it('runs collection, folder and request scripts in order, each seeing the state the previous one left', async () => {
    const t = await tree()
    const append = (c: string) =>
      `pm.variables.set('trail', (pm.variables.get('trail') || '') + '${c}'); console.log('${c}')`
    await api.collections.updateSettings(t.col, { scripts: scripts(append('C'), `pm.test('c', () => {})`) })
    await api.collections.updateSettings(t.folder, { scripts: scripts(append('F'), `pm.test('f', () => {})`) })
    const request = req({
      headers: [{ key: 'X-Trail', value: '{{trail}}', enabled: true }],
      scripts: scripts(append('R'), `pm.test('r', () => pm.expect(pm.variables.get('trail')).to.equal('CFR'))`),
    })
    const result = await send(request, { collectionPath: t.col, requestPath: t.request })
    expect(json(result).trail).toBe('CFR')
    const r = report(result)
    expect(r.logs.map((l) => [l.phase, l.source, l.text])).toEqual([
      ['pre-request', 'Collection "Shop"', 'C'],
      ['pre-request', 'Folder "Users"', 'F'],
      ['pre-request', 'Request "Get"', 'R'],
    ])
    expect(r.tests.map((x) => [x.source, x.name, x.passed])).toEqual([
      ['Collection "Shop"', 'c', true],
      ['Folder "Users"', 'f', true],
      ['Request "Get"', 'r', true],
    ])
    expect(r.failures).toEqual([])
    expect(r.changedEnvironmentIds).toEqual([])
  })

  it('skips scripts that are empty or only whitespace', async () => {
    const t = await tree()
    await api.collections.updateSettings(t.col, { scripts: scripts('  \n\t', '') })
    const result = await send(req({ scripts: scripts('', `pm.test('only', () => {})`) }), {
      collectionPath: t.col,
      requestPath: t.request,
    })
    expect(host.run).toHaveBeenCalledTimes(1)
    expect(report(result).tests.map((x) => x.name)).toEqual(['only'])
  })

  it('sends a header that a pre-request script upserted', async () => {
    const request = req({ scripts: scripts(`pm.request.headers.upsert({ key: 'X-Trail', value: 'added' })`) })
    const result = await send(request)
    expect(json(result).trail).toBe('added')
    expect(seen[0].headers['x-trail']).toBe('added')
  })
})

describe('failures', () => {
  it('does not send when a pre-request script throws, and skips the scripts after it', async () => {
    const t = await tree()
    await api.collections.updateSettings(t.col, { scripts: scripts(`throw new Error('boom')`) })
    const request = req({ scripts: scripts(`console.log('never')`) })
    const result = await send(request, { collectionPath: t.col, requestPath: t.request })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('script_error')
    expect(result.error.message).toContain('Pre-request script of Collection "Shop"')
    expect(result.error.message).toContain('boom')
    expect(report(result).failures).toEqual([
      { phase: 'pre-request', source: 'Collection "Shop"', message: 'boom' },
    ])
    expect(report(result).logs).toEqual([])
    expect(seen).toHaveLength(0)
  })

  it('records a failed post-response script and still runs the ones after it', async () => {
    const t = await tree()
    await api.collections.updateSettings(t.folder, {
      scripts: scripts('', `pm.test('before', () => {}); pm.response.json()`),
    })
    const request = req({ url: `${base}/html`, scripts: scripts('', `pm.test('after', () => {})`) })
    const result = await send(request, { collectionPath: t.col, requestPath: t.request })
    expect(result.ok).toBe(true)
    const r = report(result)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({ phase: 'post-response', source: 'Folder "Users"' })
    expect(r.tests.map((x) => [x.source, x.name])).toEqual([
      ['Folder "Users"', 'before'],
      ['Request "Get"', 'after'],
    ])
  })

  it('stops a pre-request script that loops forever and sends nothing', async () => {
    const result = await send(req({ scripts: scripts('while (true) {}') }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('script_error')
    expect(report(result).failures[0].message).toBe('Script timed out after 0.3 s')
    expect(seen).toHaveLength(0)
  })

  it('stops a post-response script that loops forever and runs the scripts after it', async () => {
    const t = await tree()
    await api.collections.updateSettings(t.col, { scripts: scripts('', `pm.test('lost', () => {}); while (true) {}`) })
    const request = req({ scripts: scripts('', `pm.test('after', () => {})`) })
    const result = await send(request, { collectionPath: t.col, requestPath: t.request })
    expect(result.ok).toBe(true)
    const r = report(result)
    expect(r.failures).toEqual([
      { phase: 'post-response', source: 'Collection "Shop"', message: 'Script timed out after 0.3 s' },
    ])
    expect(r.tests.map((x) => x.name)).toEqual(['after'])
  })

  it('cancelling the send stops a running pre-request script', async () => {
    const request = req({ scripts: scripts('await new Promise((r) => setTimeout(r, 2500))') })
    const pending = send(request, {}, 'cancel-me')
    await vi.waitFor(() => expect(host.run).toHaveBeenCalled())
    await api.http.cancel('cancel-me')
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('cancelled')
    expect(seen).toHaveLength(0)
  })
})

describe('fast path', () => {
  it('never calls the script host and returns no report when there are no scripts', async () => {
    const t = await tree()
    await api.collections.updateSettings(t.col, { scripts: scripts('', ' ') })
    const result = await send(req({ scripts: scripts('', '') }), { collectionPath: t.col, requestPath: t.request })
    expect(host.run).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect('scripts' in result).toBe(false)
  })
})

describe('variables', () => {
  const envFile = () => path.join(dir, 'environments', 'dev.json')
  const localFile = () => path.join(dir, '.local', 'environments', 'dev.json')

  async function dev(): Promise<void> {
    await saveEnv({
      id: 'env1',
      name: 'Dev',
      variables: [
        { key: 'token', value: 'initial', secret: false, enabled: true },
        { key: 'apiKey', value: '', currentValue: 'old-secret', secret: true, enabled: true },
      ],
    })
  }

  it('saves current values, encrypting secrets, and leaves the committed file alone', async () => {
    await dev()
    const committed = await fs.readFile(envFile(), 'utf8')
    const request = req({
      scripts: scripts(`pm.environment.set('token', 'next'); pm.environment.set('apiKey', 'new-secret')`),
    })
    const result = await send(request, { environmentId: 'env1' })
    expect(report(result).changedEnvironmentIds).toEqual(['env1'])
    expect(await fs.readFile(envFile(), 'utf8')).toBe(committed)
    const local = JSON.parse(await fs.readFile(localFile(), 'utf8'))
    expect(local.values).toEqual({ token: 'next', apiKey: 'x:new-secret' })
    const env = (await api.environments.list()).environments.find((e) => e.id === 'env1')!
    expect(env.variables.find((v) => v.key === 'apiKey')).toMatchObject({ secret: true, currentValue: 'new-secret' })
  })

  it('adds a key a script created and removes a key it unset', async () => {
    await dev()
    const request = req({ scripts: scripts(`pm.environment.set('fresh', 1); pm.environment.unset('token')`) })
    await send(request, { environmentId: 'env1' })
    const env = (await api.environments.list()).environments.find((e) => e.id === 'env1')!
    expect(env.variables.map((v) => v.key)).toEqual(['apiKey', 'fresh'])
    expect(env.variables[1]).toMatchObject({ key: 'fresh', value: '', currentValue: '1', secret: false })
  })

  it('creates the globals on the first pm.globals.set', async () => {
    const result = await send(req({ scripts: scripts(`pm.globals.set('g', 'v')`) }))
    expect(report(result).changedEnvironmentIds).toEqual(['globals'])
    const globals = (await api.environments.list()).environments.find((e) => e.id === 'globals')!
    expect(globals.variables).toMatchObject([{ key: 'g', currentValue: 'v' }])
  })

  it('reports no environment when none is selected', async () => {
    const result = await send(req({ scripts: scripts(`pm.environment.set('a', 'b')`) }))
    expect(result.ok).toBe(false)
    expect(report(result).failures[0].message).toBe('pm.environment.set: no environment is selected')
  })

  it('keeps collection variables for the session, applies them on the next send and clears them on close', async () => {
    const t = await tree()
    await api.collections.updateSettings(t.col, { variables: [{ key: 'n', value: '0', enabled: true }] })
    const collectionJson = await fs.readFile(path.join(dir, t.col, 'collection.json'), 'utf8')
    const request = req({
      url: `${base}/count/{{n}}`,
      scripts: scripts(`pm.collectionVariables.set('n', Number(pm.collectionVariables.get('n')) + 1)`),
    })
    expect(json(await send(request, { collectionPath: t.col })).url).toBe('/count/1')
    expect(json(await send(request, { collectionPath: t.col })).url).toBe('/count/2')
    expect(await fs.readFile(path.join(dir, t.col, 'collection.json'), 'utf8')).toBe(collectionJson)
    await api.workspace.close()
    await api.workspace.open(dir)
    expect(json(await send(request, { collectionPath: t.col })).url).toBe('/count/1')
  })

  it('resolves send-local variables before the environment', async () => {
    await dev()
    const request = req({ url: `${base}/{{token}}`, scripts: scripts(`pm.variables.set('token', 'local')`) })
    expect(json(await send(request, { environmentId: 'env1' })).url).toBe('/local')
  })
})

describe('pm.sendRequest', () => {
  it('sends through the pipeline without scripts, with variables resolved', async () => {
    await saveEnv({ id: 'env1', name: 'Dev', variables: [{ key: 'base', value: base, secret: false, enabled: true }] })
    const pre = `
      const res = await pm.sendRequest({ url: '{{base}}/side', method: 'POST', header: { 'X-Trail': 'side' } })
      pm.variables.set('side', res.json().method + ' ' + res.json().trail + ' ' + res.code)
    `
    const request = req({
      headers: [{ key: 'X-Trail', value: '{{side}}', enabled: true }],
      scripts: scripts(pre),
    })
    const result = await send(request, { environmentId: 'env1' })
    expect(json(result).trail).toBe('POST side 200')
    expect(seen.map((r) => r.url)).toEqual(['/side', '/hello'])
    expect(host.run).toHaveBeenCalledTimes(1)
  })

  it('takes a plain string as a GET', async () => {
    const request = req({
      scripts: scripts(`pm.sendRequest('${base}/plain', (err, res) => { pm.variables.set('m', res.json().method) })`),
      headers: [{ key: 'X-Trail', value: '{{m}}', enabled: true }],
    })
    expect(json(await send(request)).trail).toBe('GET')
  })
})

describe('masking', () => {
  it('masks secrets of 4 or more characters in log lines', async () => {
    await saveEnv({
      id: 'env1',
      name: 'Dev',
      variables: [
        { key: 'long', value: '', currentValue: 'supersecret', secret: true, enabled: true },
        { key: 'short', value: '', currentValue: 'abc', secret: true, enabled: true },
      ],
    })
    const pre = `
      console.log('long=' + pm.environment.get('long') + ' short=' + pm.environment.get('short'))
      pm.environment.set('long', 'rotated-value')
      console.log('now ' + pm.environment.get('long'))
    `
    const result = await send(req({ scripts: scripts(pre) }), { environmentId: 'env1' })
    expect(report(result).logs.map((l) => l.text)).toEqual(['long=•••• short=abc', 'now ••••'])
  })
})

describe('setNextRequest', () => {
  it('reports no nextRequest when no script called it', async () => {
    const result = await send(req({ scripts: scripts(`pm.test('t', () => {})`, `pm.test('u', () => {})`) }))
    expect('nextRequest' in report(result)).toBe(false)
  })

  it('reports the last call across the scripts of the send', async () => {
    const t = await tree()
    await api.collections.updateSettings(t.col, { scripts: scripts(`postman.setNextRequest('A')`) })
    await api.collections.updateSettings(t.folder, { scripts: scripts('', `postman.setNextRequest('B')`) })
    const request = req({ scripts: scripts(`postman.setNextRequest(null)`, `pm.test('t', () => {})`) })
    const result = await send(request, { collectionPath: t.col, requestPath: t.request })
    expect(report(result).nextRequest).toBe('B')
  })

  it('reports null when the last call stops the run', async () => {
    const request = req({ scripts: scripts(`postman.setNextRequest('A')`, `postman.setNextRequest(null)`) })
    expect(report(await send(request)).nextRequest).toBeNull()
  })
})

describe('iteration info and data', () => {
  function runOf(over: Partial<PipelineRun>): PipelineRun {
    return {
      request: req(),
      sources: [],
      variables: { local: {}, environment: { user: 'env-user', other: 'env-other' }, collection: {}, globals: {} },
      secretKeys: { environment: [], globals: [] },
      prepare: (r) => r,
      persist: async () => [],
      signal: new AbortController().signal,
      ...over,
    }
  }

  it('passes the iteration and the row to every script', async () => {
    const pre = `console.log(pm.info.iteration, pm.info.iterationCount, pm.iterationData.get('n'), data.user)`
    const run = runOf({
      sources: [{ source: 'Request "Get"', scripts: scripts(pre, pre) }],
      info: { iteration: 3, iterationCount: 4 },
      iterationData: { user: 'ann', n: 7 },
    })
    const result = await runWithScripts({ host, send: sendRequest, limits: LIMITS }, run)
    expect(report(result).logs.map((l) => l.text)).toEqual(['3 4 7 ann', '3 4 7 ann'])
  })

  it('defaults to the first of one iteration with no data', async () => {
    const pre = `console.log(pm.info.iteration, pm.info.iterationCount, JSON.stringify(pm.iterationData.toObject()))`
    const run = runOf({ sources: [{ source: 'Request "Get"', scripts: scripts(pre) }] })
    const result = await runWithScripts({ host, send: sendRequest, limits: LIMITS }, run)
    expect(report(result).logs.map((l) => l.text)).toEqual(['0 1 {}'])
  })

  it('resolves {{key}} from the row, after send-local variables and before the environment', async () => {
    const run = runOf({
      request: req({
        url: `${base}/{{user}}/{{id}}`,
        headers: [{ key: 'X-Trail', value: '{{other}}-{{local}}', enabled: true }],
      }),
      sources: [{ source: 'Request "Get"', scripts: scripts(`pm.variables.set('local', 'L')`) }],
      iterationData: { user: 'ann', id: 7, local: 'data-local', other: { a: 1 } },
    })
    const result = await runWithScripts({ host, send: sendRequest, limits: LIMITS }, run)
    expect(json(result)).toMatchObject({ url: '/ann/7', trail: '{"a":1}-L' })
  })

  it('resolves pm.sendRequest from the row too', async () => {
    const pre = `pm.sendRequest('${base}/{{user}}', (err, res) => { pm.variables.set('seen', res.json().url) })`
    const run = runOf({
      request: req({ headers: [{ key: 'X-Trail', value: '{{seen}}', enabled: true }] }),
      sources: [{ source: 'Request "Get"', scripts: scripts(pre) }],
      iterationData: { user: 'bob' },
    })
    const result = await runWithScripts({ host, send: sendRequest, limits: LIMITS }, run)
    expect(json(result).trail).toBe('/bob')
  })
})
