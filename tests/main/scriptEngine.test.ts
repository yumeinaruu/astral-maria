import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { engineDiagnostics, runScript, type EngineHooks, type RunOptions } from '../../src/main/scripts/engine'
import { ScriptHost } from '../../src/main/scripts/host'
import type { WorkerInit } from '../../src/main/scripts/worker'

const OPTS: RunOptions = { cpuMs: 1000, wallMs: 5000, memoryBytes: 16 * 1024 * 1024 }
const noHooks: EngineHooks = {
  sendRequest: () => Promise.reject(new Error('unexpected sendRequest')),
}

const run = (
  source: string,
  opts: Partial<RunOptions> = {},
  hooks: EngineHooks = noHooks,
  prelude = '',
  input: unknown = {},
) =>
  runScript(prelude, source, input, hooks, { ...OPTS, ...opts })

describe('runScript', () => {
  it('formats console arguments: strings as is, objects as JSON, the rest through String', async () => {
    const out = await run(`console.log('a', {b: 1}); console.warn(1, null, undefined, [1, 'x']); console.error(true)`)
    expect(out.error).toBeUndefined()
    expect(out.logs).toEqual([
      { level: 'log', text: 'a {"b":1}' },
      { level: 'warn', text: '1 null undefined [1,"x"]' },
      { level: 'error', text: 'true' },
    ])
  })

  it('has info and debug levels and formats circular objects', async () => {
    const out = await run(`const o = {a: 1}; o.self = o; console.info(o); console.debug('d')`)
    expect(out.logs).toEqual([
      { level: 'info', text: '{"a":1,"self":"[Circular]"}' },
      { level: 'debug', text: 'd' },
    ])
  })

  it('does not treat a repeated, non-circular reference as circular', async () => {
    const out = await run(`const x = {v: 1}; console.log({a: x, b: x})`)
    expect(out.logs[0].text).toBe('{"a":{"v":1},"b":{"v":1}}')
  })

  it('reports a thrown Error by its message, with kind error', async () => {
    const out = await run(`throw new Error('x')`)
    expect(out.error).toEqual({ message: 'x', kind: 'error' })
  })

  it('names errors other than plain Error', async () => {
    const out = await run(`missing.prop`)
    expect(out.error).toEqual({ message: "ReferenceError: 'missing' is not defined", kind: 'error' })
  })

  it('reports a syntax error in the script', async () => {
    const out = await run(`let = = 1`)
    expect(out.error?.kind).toBe('error')
    expect(out.error?.message).toMatch(/^SyntaxError: /)
  })

  it('keeps the logs written before an error', async () => {
    const out = await run(`console.log('before'); throw new Error('boom')`)
    expect(out.logs).toEqual([{ level: 'log', text: 'before' }])
    expect(out.error?.message).toBe('boom')
  })

  it('stops an endless loop after the CPU limit', async () => {
    const started = Date.now()
    const out = await run(`while (true) {}`, { cpuMs: 300 })
    expect(out.error).toEqual({ message: 'Script timed out after 0.3 s', kind: 'timeout' })
    expect(Date.now() - started).toBeLessThan(300 + 1000)
  })

  it('cannot catch the CPU timeout', async () => {
    const out = await run(`try { while (true) {} } catch (e) {} console.log('escaped')`, { cpuMs: 200 })
    expect(out.error?.kind).toBe('timeout')
    expect(out.logs).toEqual([])
  })

  it('formats the timeout in whole seconds when it is one', async () => {
    const out = await run(`while (true) {}`, { cpuMs: 1000 })
    expect(out.error?.message).toBe('Script timed out after 1 s')
  })

  it('stops a script that allocates past the memory limit', async () => {
    const out = await run(`const a = []; while (true) a.push(new Array(100000).fill('x' + a.length))`)
    expect(out.error?.kind).toBe('memory')
    expect(out.error?.message).toBe('Script ran out of memory (limit 16 MB)')
  })

  it('stops a single allocation past the memory limit', async () => {
    const out = await run(`const s = 'x'.repeat(64 * 1024 * 1024)`)
    expect(out.error?.kind).toBe('memory')
  })

  it('reports endless recursion as an error and stays usable', async () => {
    const out = await run(`function f() { return f() + 1 } f()`)
    expect(out.error?.kind).toBe('error')
    expect(out.error?.message).toMatch(/stack/i)
    expect((await run(`console.log('ok')`)).logs).toEqual([{ level: 'log', text: 'ok' }])
  })

  it('stays usable after a run ran out of memory', async () => {
    await run(`const a = []; while (true) a.push(new Array(100000).fill(0))`)
    const out = await run(`console.log('ok')`)
    expect(out.logs).toEqual([{ level: 'log', text: 'ok' }])
  })

  it('runs timers before finishing', async () => {
    const out = await run(`setTimeout(() => console.log('late'), 50); console.log('now')`)
    expect(out.error).toBeUndefined()
    expect(out.logs.map((l) => l.text)).toEqual(['now', 'late'])
  })

  it('passes extra arguments to timer callbacks and clears timers', async () => {
    const out = await run(`
      const t = setTimeout(() => console.log('never'), 10)
      clearTimeout(t)
      setTimeout((a, b) => console.log(a + b), 5, 1, 2)
    `)
    expect(out.logs.map((l) => l.text)).toEqual(['3'])
  })

  it('counts intervals as pending work until they are cleared', async () => {
    const out = await run(`
      let n = 0
      const id = setInterval(() => { n++; console.log('tick ' + n); if (n === 3) clearInterval(id) }, 5)
    `)
    expect(out.logs.map((l) => l.text)).toEqual(['tick 1', 'tick 2', 'tick 3'])
  })

  it('reports an error thrown in a timer callback', async () => {
    const out = await run(`setTimeout(() => { throw new Error('in timer') }, 5)`)
    expect(out.error).toEqual({ message: 'in timer', kind: 'error' })
  })

  it('stops after the wall time limit while a timer is pending', async () => {
    const out = await run(`setInterval(() => {}, 10)`, { wallMs: 200 })
    expect(out.error).toEqual({ message: 'Script timed out after 0.2 s', kind: 'timeout' })
  })

  it('drains promise jobs and supports top-level await', async () => {
    const out = await run(`
      await new Promise((r) => setTimeout(r, 10))
      Promise.resolve(1).then((v) => console.log('then ' + v))
      console.log('after await')
    `)
    expect(out.error).toBeUndefined()
    expect(out.logs.map((l) => l.text)).toEqual(['after await', 'then 1'])
  })

  it('reports an error thrown after an await', async () => {
    const out = await run(`await null; throw new Error('late boom')`)
    expect(out.error).toEqual({ message: 'late boom', kind: 'error' })
  })

  it('delivers a sendRequest result to the script callback', async () => {
    const seen: unknown[] = []
    const hooks: EngineHooks = {
      sendRequest: (raw) => {
        seen.push(raw)
        return new Promise((r) => setTimeout(() => r({ code: 200, body: 'hi' }), 20))
      },
    }
    const out = await run(
      `__sendRequest({ url: 'http://x', method: 'POST' }, (err, res) => console.log(err, res.code, res.body))`,
      {},
      hooks,
    )
    expect(out.error).toBeUndefined()
    expect(seen).toEqual([{ url: 'http://x', method: 'POST' }])
    expect(out.logs).toEqual([{ level: 'log', text: 'null 200 hi' }])
  })

  it('delivers a sendRequest failure as an Error to the callback', async () => {
    const hooks: EngineHooks = { sendRequest: () => Promise.reject(new Error('connection refused')) }
    const out = await run(
      `__sendRequest('http://x', (err, res) => console.log(err instanceof Error, err.message, typeof res))`,
      {},
      hooks,
    )
    expect(out.logs).toEqual([{ level: 'log', text: 'true connection refused undefined' }])
  })

  it('stops when the signal is aborted', async () => {
    const ctl = new AbortController()
    const pending = run(`setInterval(() => {}, 10)`, { signal: ctl.signal })
    setTimeout(() => ctl.abort(), 30)
    const out = await pending
    expect(out.error).toEqual({ message: 'Script was cancelled', kind: 'cancelled' })
  })

  it('stops a busy script when the shared cancel flag is set', async () => {
    // A busy script blocks the event loop, so another thread cancels it through shared memory.
    const cancelFlag = new Int32Array(new SharedArrayBuffer(4))
    const hooks: EngineHooks = {
      sendRequest: () => {
        Atomics.store(cancelFlag, 0, 1)
        return new Promise(() => {})
      },
    }
    const started = Date.now()
    const source = `__sendRequest('x', () => {}); while (true) {}`
    const out = await runScript('', source, {}, hooks, { ...OPTS, cpuMs: 5000, cancelFlag })
    expect(out.error).toEqual({ message: 'Script was cancelled', kind: 'cancelled' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('does not run a script whose signal is already aborted', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const out = await run(`console.log('ran')`, { signal: ctl.signal })
    expect(out).toEqual({ result: undefined, logs: [], error: { message: 'Script was cancelled', kind: 'cancelled' } })
  })

  it('stubs require with the unsupported message', async () => {
    const out = await run(`require('fs')`)
    expect(out.error).toEqual({ message: "require('fs') is not supported in Astral Maria", kind: 'error' })
  })

  it('has no process, fetch, XMLHttpRequest, and require fails', async () => {
    const out = await run(`
      console.log(typeof process, typeof fetch, typeof XMLHttpRequest, typeof require)
      try { typeof require('x') } catch (e) { console.log(e.message) }
    `)
    expect(out.logs.map((l) => l.text)).toEqual([
      'undefined undefined undefined function',
      "require('x') is not supported in Astral Maria",
    ])
  })

  it('does not allow dynamic import()', async () => {
    const out = await run(`await import('fs')`)
    expect(out.error).toEqual({ message: "import('fs') is not supported in Astral Maria", kind: 'error' })
  })

  it('shares no globals between runs', async () => {
    await run(`globalThis.leak = 1`)
    const out = await run(`console.log(typeof globalThis.leak)`)
    expect(out.logs).toEqual([{ level: 'log', text: 'undefined' }])
  })

  it('exposes the input as a frozen __input, evaluates the prelude, and returns __finish()', async () => {
    const prelude = `var seen = []; function __finish() { return { seen, input: __input } }`
    const out = await run(
      `__input.a.b = 2
      seen.push(__input.a.b, Object.isFrozen(__input.a))
      ;(function () { 'use strict'; try { __input.a.b = 3 } catch (e) { seen.push(e.name) } })()`,
      {},
      noHooks,
      prelude,
      { a: { b: 1 } },
    )
    expect(out.error).toBeUndefined()
    expect(out.result).toEqual({ seen: [1, true, 'TypeError'], input: { a: { b: 1 } } })
  })

  it('still calls __finish() after the script threw, so earlier results are kept', async () => {
    const prelude = `var n = 0; function __finish() { return n }`
    const out = await run(`n = 5; throw new Error('x')`, {}, noHooks, prelude)
    expect(out.result).toBe(5)
    expect(out.error?.message).toBe('x')
  })

  it('reports an error in the prelude', async () => {
    const out = await run(`console.log('script')`, {}, noHooks, `throw new Error('bad prelude')`)
    expect(out.error).toEqual({ message: 'bad prelude', kind: 'error' })
    expect(out.logs).toEqual([])
  })

  it('tears every run down cleanly, also after a timeout or running out of memory', async () => {
    const before = engineDiagnostics().discardedInstances
    const hooks: EngineHooks = { sendRequest: async () => ({ ok: 1 }) }
    const prelude = `function __finish() { return { done: true } }`
    await run(`setTimeout(() => {}, 1); const id = setInterval(() => clearInterval(id), 1)`, {}, hooks, prelude)
    await run(`__sendRequest('x', (e, r) => console.log(r))`, {}, hooks, prelude)
    await run(`__sendRequest('x', (e, r) => { throw new Error('in callback') })`, {}, hooks, prelude)
    await run(`await null; throw new Error('x')`, {}, hooks, prelude)
    await run(`while (true) {}`, { cpuMs: 50 }, hooks, prelude)
    await run(`const a = []; while (true) a.push(new Array(100000).fill(0))`, {}, hooks, prelude)
    expect(engineDiagnostics().discardedInstances).toBe(before)
  })

  it('caps the number of log lines', async () => {
    const out = await run(`for (let i = 0; i < 5000; i++) console.log(i)`)
    expect(out.logs).toHaveLength(1001)
    expect(out.logs[1000]).toEqual({ level: 'warn', text: 'Further console output was dropped (limit 1000 lines)' })
  })
})

// ---- ScriptHost with a real worker_threads worker -------------------------------------------------------------

// The worker entry is TypeScript. Node strips the types itself; the hook below lets its extensionless relative
// imports (as Vite writes them) resolve to the .ts files.
const workerEntry = fileURLToPath(new URL('../../src/main/scripts/worker.ts', import.meta.url))
const bootstrap = `
const { registerHooks } = require('node:module')
const { pathToFileURL } = require('node:url')
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (e) {
      if (specifier.startsWith('.')) return next(specifier + '.ts', context)
      throw e
    }
  },
  load(url, context, next) {
    return url.endsWith('.ts') ? next(url, { ...context, format: 'module-typescript' }) : next(url, context)
  },
})
import(pathToFileURL(${JSON.stringify(workerEntry)}).href)
`
const spawnWorker = (workerData?: WorkerInit) => new Worker(bootstrap, { eval: true, workerData })

describe('ScriptHost', () => {
  let host: ScriptHost | undefined
  afterEach(async () => {
    await host?.dispose()
    host = undefined
  })

  it('runs a script in the worker and relays sendRequest', async () => {
    host = new ScriptHost(() => spawnWorker())
    const hooks: EngineHooks = { sendRequest: async (raw) => ({ echoed: raw }) }
    const out = await host.run(
      `function __finish() { return 'done' }`,
      `__sendRequest({ u: 1 }, (err, res) => console.log(JSON.stringify(res)))`,
      {},
      hooks,
      OPTS,
    )
    expect(out).toEqual({ result: 'done', logs: [{ level: 'log', text: '{"echoed":{"u":1}}' }] })
  })

  it('uses the wasm bytes the main process passes', async () => {
    const wasm = readFileSync(createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-sync/wasm'))
    host = new ScriptHost(() => spawnWorker({ wasm }))
    const out = await host.run('', `console.log(1 + 1)`, {}, noHooks, OPTS)
    expect(out.logs).toEqual([{ level: 'log', text: '2' }])
  })

  it('runs several scripts at once', async () => {
    host = new ScriptHost(() => spawnWorker())
    const outs = await Promise.all(
      [30, 10, 20].map((ms) => host!.run('', `setTimeout(() => console.log('${ms}'), ${ms})`, {}, noHooks, OPTS)),
    )
    expect(outs.map((o) => o.logs[0].text)).toEqual(['30', '10', '20'])
  })

  it('reports a timeout and runs the next script in a fresh worker', async () => {
    let spawned = 0
    host = new ScriptHost(() => {
      spawned++
      return spawnWorker()
    })
    const out = await host.run('', `while (true) {}`, {}, noHooks, { ...OPTS, cpuMs: 200 })
    expect(out.error).toEqual({ message: 'Script timed out after 0.2 s', kind: 'timeout' })
    const next = await host.run('', `console.log('alive')`, {}, noHooks, OPTS)
    expect(next.logs).toEqual([{ level: 'log', text: 'alive' }])
    expect(spawned).toBe(2)
  })

  it('reuses the worker between ordinary runs', async () => {
    let spawned = 0
    host = new ScriptHost(() => {
      spawned++
      return spawnWorker()
    })
    await host.run('', `throw new Error('x')`, {}, noHooks, OPTS)
    await host.run('', `console.log(1)`, {}, noHooks, OPTS)
    expect(spawned).toBe(1)
  })

  it('cancels a busy script through its signal', async () => {
    host = new ScriptHost(() => spawnWorker())
    const ctl = new AbortController()
    const started = Date.now()
    const pending = host.run('', `while (true) {}`, {}, noHooks, { ...OPTS, cpuMs: 10_000, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 100)
    expect((await pending).error).toEqual({ message: 'Script was cancelled', kind: 'cancelled' })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('cancels a run through its signal', async () => {
    host = new ScriptHost(() => spawnWorker())
    const ctl = new AbortController()
    const pending = host.run('', `setInterval(() => {}, 10)`, {}, noHooks, { ...OPTS, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 30)
    expect((await pending).error?.kind).toBe('cancelled')
  })

  it('replaces a worker that stops answering, failing its runs as timed out', async () => {
    let spawned = 0
    // A worker that never answers stands in for one stuck where the interrupt handler cannot reach.
    const stuck = () => {
      spawned++
      return spawned === 1 ? new Worker('setInterval(() => {}, 1000)', { eval: true }) : spawnWorker()
    }
    host = new ScriptHost(stuck, { graceMs: 100 })
    const out = await host.run('', `console.log('x')`, {}, noHooks, { ...OPTS, wallMs: 100 })
    expect(out.error).toEqual({ message: 'Script timed out after 0.1 s', kind: 'timeout' })
    const next = await host.run('', `console.log('fresh')`, {}, noHooks, OPTS)
    expect(next.logs).toEqual([{ level: 'log', text: 'fresh' }])
    expect(spawned).toBe(2)
  })

  it('fails a run whose input cannot be passed to the worker', async () => {
    host = new ScriptHost(() => spawnWorker())
    const out = await host.run('', `console.log(1)`, { f: () => 1 }, noHooks, OPTS)
    expect(out.error?.kind).toBe('error')
    expect(out.error?.message).toMatch(/^The script input could not be passed to the sandbox/)
  })

  it('fails pending runs as cancelled on dispose', async () => {
    host = new ScriptHost(() => spawnWorker())
    const pending = host.run('', `setInterval(() => {}, 10)`, {}, noHooks, OPTS)
    await new Promise((r) => setTimeout(r, 50))
    await host.dispose()
    expect((await pending).error?.kind).toBe('cancelled')
  })
})
