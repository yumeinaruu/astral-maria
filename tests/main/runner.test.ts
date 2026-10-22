import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApi } from '../../src/main/api'
import {
  MAX_ITERATION_EXECUTIONS,
  startRun,
  type PlanEntry,
  type RunnerDeps,
  type SendOneInput,
} from '../../src/main/runner/runner'
import { runScript } from '../../src/main/scripts/engine'
import type { ScriptRunner } from '../../src/main/scripts/pipeline'
import type { AstralApi } from '../../src/shared/api'
import type { HttpResponse, RunEvent, RunOptions, ScriptReport, SendResult } from '../../src/shared/types'

// The run loop with fake deps, then the runner end to end through createApi with the in-process script engine.

const COL = 'collections/c'
const A = `${COL}/a.request.json`
const B = `${COL}/b.request.json`
const C = `${COL}/c.request.json`

const entry = (p: string, name: string, over: Partial<PlanEntry> = {}): PlanEntry => ({
  path: p,
  name,
  method: 'GET',
  ...over,
})

const PLAN = [entry(A, 'A'), entry(B, 'B'), entry(C, 'C')]
const nameOf = (p: string) => PLAN.find((e) => e.path === p)?.name ?? p

function response(over: Partial<HttpResponse> = {}): HttpResponse {
  return {
    status: 200,
    statusText: 'OK',
    headers: [],
    bodyBase64: '',
    bodyTruncated: false,
    sizeBytes: 12,
    totalMs: 7,
    finalUrl: 'http://example.test/x',
    redirects: 0,
    cookies: [],
    ...over,
  }
}

const report = (over: Partial<ScriptReport> = {}): ScriptReport => ({
  tests: [],
  logs: [],
  failures: [],
  changedEnvironmentIds: [],
  ...over,
})

const ok = (scripts?: Partial<ScriptReport>): SendResult => ({
  ok: true,
  response: response(),
  ...(scripts && { scripts: report(scripts) }),
})

function options(over: Partial<RunOptions> = {}): RunOptions {
  return {
    path: COL,
    requestPaths: [A, B, C],
    environmentId: null,
    iterations: 1,
    delayMs: 0,
    data: null,
    keepVariables: true,
    stopOnError: false,
    ...over,
  }
}

interface Fake {
  deps: RunnerDeps
  events: RunEvent[]
  calls: SendOneInput[]
  /** Sends and sleeps, in order: the request name, or `sleep <ms>`. */
  trail: string[]
}

function fake(
  send: (input: SendOneInput, n: number) => Promise<SendResult> | SendResult = () => ok(),
  over: Partial<RunnerDeps> = {},
): Fake {
  const events: RunEvent[] = []
  const calls: SendOneInput[] = []
  const trail: string[] = []
  const deps: RunnerDeps = {
    loadPlan: async () => PLAN,
    async sendOne(input) {
      calls.push(input)
      trail.push(nameOf(input.requestPath))
      return send(input, calls.length)
    },
    emit: (e) => events.push(e),
    async sleep(ms) {
      trail.push(`sleep ${ms}`)
    },
    ...over,
  }
  return { deps, events, calls, trail }
}

async function run(f: Fake, opts: Partial<RunOptions> = {}) {
  const handle = startRun(f.deps, options(opts))
  await handle.done
  return handle
}

const results = (events: RunEvent[]) => events.flatMap((e) => (e.type === 'result' ? [e.result] : []))
const finished = (events: RunEvent[]) => events.find((e) => e.type === 'finished')

describe('run order', () => {
  it('runs the selected requests in order, once per iteration, cycling through the data rows', async () => {
    const f = fake()
    const rows = [{ n: 1 }, { n: 2 }]
    const handle = await run(f, {
      requestPaths: [A, C],
      iterations: 3,
      data: { name: 'd.json', rows },
    })
    expect(f.calls.map((c) => [c.info.iteration, nameOf(c.requestPath), c.data])).toEqual([
      [0, 'A', { n: 1 }],
      [0, 'C', { n: 1 }],
      [1, 'A', { n: 2 }],
      [1, 'C', { n: 2 }],
      [2, 'A', { n: 1 }],
      [2, 'C', { n: 1 }],
    ])
    expect(f.calls.every((c) => c.info.iterationCount === 3)).toBe(true)
    expect(f.events[0]).toMatchObject({ runId: handle.runId, type: 'started', total: 6 })
    expect(results(f.events).map((r) => [r.iteration, r.name])).toEqual([
      [0, 'A'],
      [0, 'C'],
      [1, 'A'],
      [1, 'C'],
      [2, 'A'],
      [2, 'C'],
    ])
    expect(f.events.at(-1)).toMatchObject({ runId: handle.runId, type: 'finished', reason: 'completed' })
    expect(f.events.every((e) => e.runId === handle.runId)).toBe(true)
  })

  it('gives every iteration an empty data row when there is no data file', async () => {
    const f = fake()
    await run(f, { requestPaths: [A], iterations: 2 })
    expect(f.calls.map((c) => c.data)).toEqual([{}, {}])
  })

  it('maps the send result into the run result', async () => {
    const tests = [{ name: 't', passed: true, skipped: false, source: 'Request "A"' }]
    const failures = [{ phase: 'post-response' as const, source: 'Request "A"', message: 'boom' }]
    const f = fake((input) =>
      input.requestPath === A
        ? { ...ok({ tests, failures }), url: 'http://example.test/a?k=••••' }
        : { ok: false, error: { code: 'network_error', message: 'connect ECONNREFUSED' } },
    )
    await run(f, { requestPaths: [A, B] })
    expect(results(f.events)).toEqual([
      {
        iteration: 0,
        path: A,
        name: 'A',
        method: 'GET',
        url: 'http://example.test/a?k=••••',
        status: 200,
        statusText: 'OK',
        timeMs: 7,
        sizeBytes: 12,
        tests,
        failures,
      },
      {
        iteration: 0,
        path: B,
        name: 'B',
        method: 'GET',
        url: '',
        tests: [],
        failures: [],
        error: 'connect ECONNREFUSED',
      },
    ])
  })
})

describe('setNextRequest', () => {
  it('jumps to the first selected request with that name', async () => {
    let jumpedBack = false
    const f = fake((input) => {
      if (input.requestPath === A) return ok({ nextRequest: 'C' })
      return ok()
    })
    await run(f, { iterations: 2 })
    expect(f.trail).toEqual(['A', 'C', 'A', 'C'])

    const g = fake((input) => {
      if (input.requestPath === B && !jumpedBack) {
        jumpedBack = true
        return ok({ nextRequest: 'A' })
      }
      return ok()
    })
    await run(g)
    expect(g.trail).toEqual(['A', 'B', 'A', 'B', 'C'])
  })

  it('stops the whole run, as completed, on null', async () => {
    const f = fake((input) => (input.requestPath === B ? ok({ nextRequest: null }) : ok()))
    await run(f, { iterations: 3 })
    expect(f.trail).toEqual(['A', 'B'])
    expect(finished(f.events)).toMatchObject({ reason: 'completed' })
  })

  it('stops with next_request_not_found for a name no selected request has', async () => {
    // "C" exists but is not selected.
    const f = fake((input) => (input.requestPath === A ? ok({ nextRequest: 'C' }) : ok()))
    await run(f, { requestPaths: [A, B], iterations: 2 })
    expect(f.trail).toEqual(['A'])
    expect(results(f.events)).toHaveLength(1)
    expect(finished(f.events)).toMatchObject({ reason: 'next_request_not_found: "C"' })
  })

  it('stops with loop_guard after the maximum executions in one iteration', async () => {
    const f = fake(() => ok({ nextRequest: 'A' }))
    await run(f, { requestPaths: [A, B], iterations: 2 })
    expect(f.calls).toHaveLength(MAX_ITERATION_EXECUTIONS)
    expect(f.calls.every((c) => c.info.iteration === 0)).toBe(true)
    expect(finished(f.events)).toMatchObject({ reason: 'loop_guard' })
  })
})

describe('delay', () => {
  it('sleeps between consecutive requests, across iterations, but not after the last one', async () => {
    const f = fake()
    await run(f, { requestPaths: [A, B], iterations: 2, delayMs: 250 })
    expect(f.trail).toEqual(['A', 'sleep 250', 'B', 'sleep 250', 'A', 'sleep 250', 'B'])
  })

  it('does not sleep without a delay', async () => {
    const f = fake()
    await run(f, { requestPaths: [A, B], iterations: 2 })
    expect(f.trail).toEqual(['A', 'B', 'A', 'B'])
  })
})

describe('stopOnError', () => {
  it('stops after the first result with an error', async () => {
    const f = fake((input) =>
      input.requestPath === B ? { ok: false, error: { code: 'network_error', message: 'down' } } : ok(),
    )
    await run(f, { stopOnError: true, iterations: 2 })
    expect(f.trail).toEqual(['A', 'B'])
    expect(finished(f.events)).toMatchObject({ reason: 'error' })
  })

  it('stops after the first failed test, but not after a skipped one', async () => {
    const test = (passed: boolean, skipped: boolean) => [{ name: 't', passed, skipped, source: 's' }]
    const f = fake((input) => {
      if (input.requestPath === A) return ok({ tests: test(false, true) })
      if (input.requestPath === B) return ok({ tests: test(false, false) })
      return ok()
    })
    await run(f, { stopOnError: true })
    expect(f.trail).toEqual(['A', 'B'])
    expect(finished(f.events)).toMatchObject({ reason: 'error' })
  })

  it('carries on after errors when it is off', async () => {
    const f = fake(() => ({ ok: false, error: { code: 'network_error', message: 'down' } }))
    await run(f)
    expect(f.trail).toEqual(['A', 'B', 'C'])
    expect(finished(f.events)).toMatchObject({ reason: 'completed' })
  })
})

describe('stopping', () => {
  it('aborts the request in flight, keeps the results so far and sends nothing more', async () => {
    let release!: () => void
    const f = fake((input, n) =>
      n === 1
        ? ok()
        : new Promise<SendResult>((resolve) => {
            release = () => resolve({ ok: false, error: { code: 'cancelled', message: 'Request was cancelled' } })
            input.signal.addEventListener('abort', () => setTimeout(release, 10))
          }),
    )
    const handle = startRun(f.deps, options({ iterations: 5 }))
    while (f.calls.length < 2) await new Promise((r) => setTimeout(r, 1))
    handle.stop()
    expect(f.calls[1].signal.aborted).toBe(true)
    // `finished` is out as soon as stop() returns.
    expect(f.events.map((e) => e.type)).toEqual(['started', 'result', 'finished'])
    expect(finished(f.events)).toMatchObject({ reason: 'stopped' })
    await handle.done
    expect(f.calls).toHaveLength(2)
    expect(f.events.map((e) => e.type)).toEqual(['started', 'result', 'finished'])
    handle.stop()
    expect(f.events).toHaveLength(3)
  })

  it('cancels the delay', async () => {
    const f = fake(undefined, {
      sleep: (_ms, signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())),
    })
    const handle = startRun(f.deps, options({ delayMs: 600_000 }))
    while (f.calls.length < 1) await new Promise((r) => setTimeout(r, 1))
    await new Promise((r) => setTimeout(r, 5))
    handle.stop()
    await handle.done
    expect(f.trail).toEqual(['A'])
    expect(f.events.map((e) => e.type)).toEqual(['started', 'result', 'finished'])
    expect(finished(f.events)).toMatchObject({ reason: 'stopped' })
  })

  it('stopped before the plan is loaded, emits nothing and rejects started', async () => {
    let load!: () => void
    const f = fake(undefined, {
      loadPlan: () => new Promise((resolve) => (load = () => resolve(PLAN))),
    })
    const handle = startRun(f.deps, options())
    handle.stop()
    load()
    await expect(handle.started).rejects.toThrow('run_stopped')
    await handle.done
    expect(f.events).toEqual([])
    expect(f.calls).toEqual([])
  })

  it('rejects started, emitting nothing, when the plan cannot be loaded', async () => {
    const f = fake(undefined, {
      loadPlan: async () => {
        throw new Error('not_found: collections/c')
      },
    })
    const handle = startRun(f.deps, options())
    await expect(handle.started).rejects.toThrow('not_found: collections/c')
    await handle.done
    expect(f.events).toEqual([])
  })
})

describe('load errors', () => {
  it('reports a request whose file failed to load as a failed result and carries on', async () => {
    const f = fake(undefined, {
      loadPlan: async () => [
        entry(A, 'A'),
        entry(B, 'b', { loadError: 'Invalid request in b.request.json' }),
        entry(C, 'C'),
      ],
    })
    await run(f)
    expect(f.trail).toEqual(['A', 'C'])
    expect(results(f.events).map((r) => [r.name, r.error])).toEqual([
      ['A', undefined],
      ['b', 'Invalid request in b.request.json'],
      ['C', undefined],
    ])
    expect(finished(f.events)).toMatchObject({ reason: 'completed' })
  })

  it('reports a selected request that is no longer there', async () => {
    const f = fake(undefined, { loadPlan: async () => [entry(A, 'A'), entry(C, 'C')] })
    await run(f)
    expect(f.trail).toEqual(['A', 'C'])
    expect(results(f.events)[1]).toMatchObject({ path: B, name: 'b', error: 'Request not found' })
  })
})

describe('options', () => {
  it.each<[string, Partial<RunOptions>]>([
    ['iterations', { iterations: 0 }],
    ['iterations', { iterations: 10_001 }],
    ['iterations', { iterations: 1.5 }],
    ['delayMs', { delayMs: -1 }],
    ['delayMs', { delayMs: 600_001 }],
    ['delayMs', { delayMs: Number.NaN }],
    ['requestPaths', { requestPaths: [] }],
    ['requestPaths', { requestPaths: [A, 'collections/other/x.request.json'] }],
    ['requestPaths', { requestPaths: ['collections/cc/x.request.json'] }],
    ['requestPaths', { requestPaths: [COL] }],
    ['path', { path: 5 as unknown as string }],
    ['environmentId', { environmentId: 5 as unknown as string }],
    ['data', { data: { name: 'd', rows: [] } }],
    ['data', { data: { name: 'd', rows: [5 as unknown as Record<string, unknown>] } }],
    ['keepVariables', { keepVariables: 'yes' as unknown as boolean }],
    ['stopOnError', { stopOnError: undefined as unknown as boolean }],
  ])('rejects a bad %s', (field, over) => {
    expect(() => startRun(fake().deps, options(over))).toThrow(`invalid_run_options: ${field}`)
  })

  it('accepts the limits', async () => {
    const f = fake()
    await run(f, { requestPaths: [A], iterations: 1, delayMs: 600_000 })
    expect(finished(f.events)).toMatchObject({ reason: 'completed' })
  })

  it('passes one overlay for the whole run when variables are not kept, and none when they are', async () => {
    const f = fake()
    await run(f, { keepVariables: false, iterations: 2 })
    const overlay = f.calls[0].overlay
    expect(overlay).not.toBeNull()
    expect(f.calls.every((c) => c.overlay === overlay)).toBe(true)

    const g = fake()
    await run(g)
    expect(g.calls.every((c) => c.overlay === null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Through createApi: the real pipeline, with the script engine running in this process.

const cipher = {
  encrypt: (s: string) => `x:${s}`,
  decrypt: (s: string) => s.replace(/^x:/, ''),
}

describe('runner through the API', () => {
  let tmp: string
  let server: Server
  let base: string
  let seen: IncomingMessage[]
  let slow: (() => void)[]
  let events: RunEvent[]
  let api: AstralApi

  const host: ScriptRunner = {
    run: (prelude, source, input, hooks, opts) => runScript(prelude, source, input, hooks, opts),
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astral-runner-'))
    seen = []
    slow = []
    events = []
    server = createServer((req, res) => {
      seen.push(req)
      if (req.url?.startsWith('/slow')) {
        slow.push(() => res.end('late'))
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ url: req.url }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    api = createApi({
      cipher,
      pickDirectory: async () => null,
      pickImportFiles: async () => [],
      pickExportPath: async () => null,
      recentFile: path.join(tmp, 'recent.json'),
      scriptHost: host,
      scriptLimits: { cpuMs: 300, wallMs: 3000, memoryBytes: 64 * 1024 * 1024 },
      emitRunEvent: (e) => events.push(e),
    })
    await api.workspace.create(path.join(tmp, 'ws'), 'ws')
  })

  afterEach(async () => {
    for (const finish of slow) finish()
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    await fs.rm(tmp, { recursive: true, force: true })
  })

  async function request(parent: string, name: string, url: string, postResponse = ''): Promise<string> {
    const node = await api.collections.createRequest(parent, name)
    await api.collections.saveRequest(node.path, {
      ...node.request,
      url,
      ...(postResponse && { scripts: { preRequest: '', postResponse } }),
    })
    return node.path
  }

  const done = () => waitFor(() => events.some((e) => e.type === 'finished'))

  function runOptions(over: Partial<RunOptions> & Pick<RunOptions, 'path' | 'requestPaths'>): RunOptions {
    return {
      environmentId: null,
      iterations: 1,
      delayMs: 0,
      data: null,
      keepVariables: true,
      stopOnError: false,
      ...over,
    }
  }

  it('without keepVariables, later requests see script changes but nothing is persisted', async () => {
    await api.environments.save({
      id: 'e1',
      name: 'Dev',
      variables: [{ key: 'token', value: 'old', secret: false, enabled: true }],
    })
    const col = await api.collections.createCollection('Shop')
    const setter = await request(
      col.path,
      'Set',
      `${base}/set`,
      `pm.environment.set('token', 'abc'); pm.globals.set('g', '1'); pm.collectionVariables.set('cv', 'x')`,
    )
    // No scripts: the plain path must read the run's variables too.
    const plain = await request(col.path, 'Plain', `${base}/{{token}}/{{g}}/{{cv}}`)
    const scripted = await request(
      col.path,
      'Scripted',
      `${base}/s/{{token}}`,
      `pm.test('sees the run value', () => pm.expect(pm.environment.get('token')).to.equal('abc'))`,
    )
    await api.runner.start(
      runOptions({
        path: col.path,
        requestPaths: [setter, plain, scripted],
        environmentId: 'e1',
        keepVariables: false,
      }),
    )
    await done()
    expect(seen.map((r) => r.url)).toEqual(['/set', '/abc/1/x', '/s/abc'])
    const res = results(events)
    expect(res[2].tests).toMatchObject([{ name: 'sees the run value', passed: true }])
    expect(res.map((r) => r.url)).toEqual([`${base}/set`, `${base}/abc/1/x`, `${base}/s/abc`])
    const { environments } = await api.environments.list()
    expect(environments.map((e) => e.id)).toEqual(['e1'])
    expect(environments[0].variables[0]).toMatchObject({ value: 'old' })
    expect(environments[0].variables[0].currentValue ?? 'old').toBe('old')
    // Nor did the collection's session variables change: a send afterwards sees the stored values.
    const after = await api.http.send(
      {
        id: 'x',
        name: 'x',
        method: 'GET',
        url: `${base}/{{token}}/{{cv}}`,
        params: [],
        headers: [],
        body: { mode: 'none' },
        auth: { type: 'none' },
      },
      { collectionPath: col.path, environmentId: 'e1', requestPath: plain },
      's',
    )
    expect(after.ok).toBe(true)
    expect(seen.at(-1)?.url).toBe('/old/%7B%7Bcv%7D%7D')
  })

  it('with keepVariables, script changes are saved', async () => {
    await api.environments.save({
      id: 'e1',
      name: 'Dev',
      variables: [{ key: 'token', value: 'old', secret: false, enabled: true }],
    })
    const col = await api.collections.createCollection('Shop')
    const setter = await request(col.path, 'Set', `${base}/set`, `pm.environment.set('token', 'abc')`)
    await api.runner.start(runOptions({ path: col.path, requestPaths: [setter], environmentId: 'e1' }))
    await done()
    const { environments } = await api.environments.list()
    expect(environments[0].variables[0].currentValue).toBe('abc')
  })

  it('runs only one run per workspace at a time', async () => {
    const col = await api.collections.createCollection('Shop')
    const r = await request(col.path, 'Slow', `${base}/slow`)
    const runId = await api.runner.start(runOptions({ path: col.path, requestPaths: [r] }))
    await expect(api.runner.start(runOptions({ path: col.path, requestPaths: [r] }))).rejects.toThrow('runner_busy')
    await waitFor(() => seen.length === 1)
    await api.runner.stop(runId)
    expect(events.at(-1)).toMatchObject({ runId, type: 'finished', reason: 'stopped' })
    const next = await api.runner.start(runOptions({ path: col.path, requestPaths: [r] }))
    expect(next).not.toBe(runId)
    await api.runner.stop(next)
  })

  it.each(['close', 'switch'])('stops the run when the workspace is closed or switched (%s)', async (how) => {
    const col = await api.collections.createCollection('Shop')
    const r = await request(col.path, 'Slow', `${base}/slow`)
    const runId = await api.runner.start(runOptions({ path: col.path, requestPaths: [r], iterations: 3 }))
    await waitFor(() => seen.length === 1)
    if (how === 'close') await api.workspace.close()
    else await api.workspace.create(path.join(tmp, 'other'), 'other')
    expect(events.map((e) => e.type)).toEqual(['started', 'finished'])
    expect(events.at(-1)).toMatchObject({ runId, reason: 'stopped' })
    for (const finish of slow) finish()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(events).toHaveLength(2)
    expect(seen).toHaveLength(1)
  })

  it('rejects invalid options and an unknown path', async () => {
    const col = await api.collections.createCollection('Shop')
    const r = await request(col.path, 'R', `${base}/r`)
    await expect(api.runner.start(runOptions({ path: col.path, requestPaths: [] }))).rejects.toThrow(
      'invalid_run_options: requestPaths',
    )
    await expect(
      api.runner.start(runOptions({ path: 'collections/nope', requestPaths: ['collections/nope/x.request.json'] })),
    ).rejects.toThrow('not_found')
    // The failed start left the runner free.
    await api.runner.start(runOptions({ path: col.path, requestPaths: [r] }))
    await done()
    expect(events.map((e) => e.type)).toEqual(['started', 'result', 'finished'])
  })

  it('runs a folder with the collection and folder scripts around each request', async () => {
    const col = await api.collections.createCollection('Shop')
    const folder = await api.collections.createFolder(col.path, 'Users')
    await api.collections.updateSettings(col.path, {
      scripts: { preRequest: '', postResponse: `pm.test('collection', () => {})` },
    })
    const r = await request(folder.path, 'R', `${base}/r`)
    await api.runner.start(runOptions({ path: folder.path, requestPaths: [r] }))
    await done()
    expect(results(events)[0].tests.map((t) => t.name)).toEqual(['collection'])
  })

  it('reports a request file that fails to load and carries on', async () => {
    const col = await api.collections.createCollection('Shop')
    const broken = await request(col.path, 'Broken', `${base}/broken`)
    const fine = await request(col.path, 'Fine', `${base}/fine`)
    await fs.writeFile(path.join(tmp, 'ws', broken), '{ not json')
    await api.runner.start(runOptions({ path: col.path, requestPaths: [broken, fine] }))
    await done()
    const [first, second] = results(events)
    expect(first.path).toBe(broken)
    expect(first.error).toMatch(/broken\.request\.json/)
    expect(second).toMatchObject({ path: fine, status: 200 })
    expect(seen.map((s) => s.url)).toEqual(['/fine'])
  })
})

async function waitFor(cond: () => boolean): Promise<void> {
  const until = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}
