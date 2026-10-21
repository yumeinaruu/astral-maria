import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSSyncVariant,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core'
import { QuickJSFFI } from '@jitl/quickjs-wasmfile-release-sync/ffi'
import moduleLoader from '@jitl/quickjs-wasmfile-release-sync/emscripten-module'

// Runs untrusted scripts in QuickJS compiled to WebAssembly. The VM shares no objects with Node: values cross as
// JSON strings, and its only host functions are console output, timers and the sendRequest bridge. The sync build
// is used; timers, sendRequest and promise jobs are driven from here.

export interface EngineHooks {
  /** Bridges pm.sendRequest; the engine passes the raw Postman-style request and gets a plain response object. */
  sendRequest(raw: unknown): Promise<unknown>
}

export interface RunOptions {
  cpuMs: number
  wallMs: number
  memoryBytes: number
  signal?: AbortSignal
}

/**
 * The options the worker passes. `cancelFlag` is a shared Int32Array that another thread sets to 1 to cancel: a
 * busy script blocks this thread's event loop, so an abort event could not be delivered until it yields.
 */
export interface EngineRunOptions extends RunOptions {
  cancelFlag?: Int32Array
}

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'
export type FailureKind = 'error' | 'timeout' | 'memory' | 'cancelled'

export interface RunOutput {
  /** JSON-serialisable value returned by the runtime's `__finish()`; see Task 2. */
  result: unknown
  logs: { level: LogLevel; text: string }[]
  error?: { message: string; kind: FailureKind }
}

/** Console lines kept per run; the host holds them outside the VM's memory limit. */
export const MAX_LOG_LINES = 1000
/** Characters kept per console line. */
export const MAX_LOG_TEXT = 100_000
/** The VM's own stack, so deep recursion fails as a RangeError-like error instead of overflowing the wasm stack. */
const MAX_STACK_BYTES = 1024 * 1024

// ---- Loading the wasm ------------------------------------------------------------------------------------------

let wasmBytes: Uint8Array | undefined
let compiled: Promise<WebAssembly.Module> | undefined
let quickjs: Promise<QuickJSWASMModule> | undefined

/** Supplies the QuickJS wasm. The packaged app reads it in the main process (asar-aware) and passes the bytes. */
export function configureEngine(options: { wasm: Uint8Array }): void {
  wasmBytes = options.wasm
  compiled = undefined
  quickjs = undefined
}

/** Without configureEngine (tests, plain Node), the wasm is read from the installed package. */
function defaultWasm(): Uint8Array {
  const path = createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-sync/wasm')
  return readFileSync(path)
}

// The variant's own loader imports these lazily; importing them statically keeps the bundle in one file.
const variant: QuickJSSyncVariant = {
  type: 'sync',
  importFFI: async () => QuickJSFFI,
  importModuleLoader: async () => moduleLoader,
}

/**
 * Runs per wasm instance. Each run frees its runtime, but the instance's heap only grows, so a fresh one (cheap: the
 * compiled module is kept) bounds fragmentation over a long session. Runs in flight keep the old one alive.
 */
const RUNS_PER_INSTANCE = 100
let runsOnInstance = 0

function loadQuickJS(): Promise<QuickJSWASMModule> {
  compiled ??= WebAssembly.compile((wasmBytes ?? defaultWasm()) as Uint8Array<ArrayBuffer>)
  const module = compiled
  if (runsOnInstance >= RUNS_PER_INSTANCE) quickjs = undefined
  if (!quickjs) {
    runsOnInstance = 0
    quickjs = newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmModule: () => module }))
  }
  runsOnInstance++
  return quickjs
}

let discarded = 0

/** After a failed teardown the wasm instance's state is suspect; the next run instantiates a fresh one. */
function discardQuickJS(): void {
  quickjs = undefined
  discarded++
}

/** How many wasm instances were thrown away after a failed start or teardown; for tests and logging. */
export function engineDiagnostics(): { discardedInstances: number } {
  return { discardedInstances: discarded }
}

// ---- Inside the VM ---------------------------------------------------------------------------------------------

/**
 * Evaluated first in every context. It takes the host functions and the input as arguments, so none of them is
 * reachable as a global, installs the globals scripts may use, and returns the entry points the host calls.
 */
const BOOTSTRAP = String.raw`(function (hostLog, hostSetTimer, hostClearTimer, hostSend, hostFail, inputJson) {
  'use strict'
  const g = globalThis
  const define = (name, value) =>
    Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false })

  function stringify(value) {
    const ancestors = []
    return JSON.stringify(value, function (key, v) {
      if (typeof v !== 'object' || v === null) return v
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop()
      if (ancestors.includes(v)) return '[Circular]'
      ancestors.push(v)
      return v
    })
  }
  function format(value) {
    if (typeof value === 'string') return value
    if (value instanceof Error) return String(value)
    if (typeof value === 'object' && value !== null) {
      try {
        const text = stringify(value)
        return text === undefined ? String(value) : text
      } catch (e) {
        return String(value)
      }
    }
    return String(value)
  }

  const console = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    console[level] = function (...args) { hostLog(level, args.map(format).join(' ')) }
  }
  define('console', console)

  const timers = new Map()
  let nextTimer = 0
  function schedule(name, fn, ms, args, repeat) {
    if (typeof fn !== 'function') throw new TypeError(name + ': the callback must be a function')
    const id = ++nextTimer
    const delay = Math.max(0, Number(ms) || 0)
    timers.set(id, { fn, args, repeat })
    hostSetTimer(id, delay)
    return id
  }
  function clear(id) {
    if (timers.delete(id)) hostClearTimer(id)
  }
  define('setTimeout', function setTimeout(fn, ms, ...args) { return schedule('setTimeout', fn, ms, args, false) })
  define('setInterval', function setInterval(fn, ms, ...args) { return schedule('setInterval', fn, ms, args, true) })
  define('clearTimeout', function clearTimeout(id) { clear(id) })
  define('clearInterval', function clearInterval(id) { clear(id) })

  define('require', function require(name) {
    throw new Error("require('" + String(name) + "') is not supported in Astral Maria")
  })

  const sends = new Map()
  let nextSend = 0
  define('__sendRequest', function __sendRequest(raw, callback) {
    if (typeof callback !== 'function') throw new TypeError('__sendRequest: the callback must be a function')
    const id = ++nextSend
    sends.set(id, callback)
    const json = JSON.stringify(raw)
    hostSend(id, json === undefined ? 'null' : json)
  })

  const freeze = (v) => {
    if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
      Object.freeze(v)
      for (const k of Object.keys(v)) freeze(v[k])
    }
    return v
  }
  const input = freeze(JSON.parse(inputJson))
  Object.defineProperty(g, '__input', { value: input, writable: false, configurable: false, enumerable: false })

  return {
    start(main) {
      main().then(undefined, hostFail)
    },
    fireTimer(id) {
      const t = timers.get(id)
      if (!t) return false
      if (!t.repeat) timers.delete(id)
      t.fn.apply(undefined, t.args)
      return t.repeat && timers.has(id)
    },
    settleSend(id, errorMessage, json) {
      const callback = sends.get(id)
      sends.delete(id)
      if (!callback) return
      if (errorMessage !== null) callback(new Error(errorMessage), undefined)
      else callback(null, JSON.parse(json))
    },
    finish() {
      if (typeof g.__finish !== 'function') return undefined
      return JSON.stringify(g.__finish())
    },
  }
})`

// ---- Running ---------------------------------------------------------------------------------------------------

type Failure = NonNullable<RunOutput['error']>

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`
const megabytes = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`
const CANCELLED: Failure = { message: 'Script was cancelled', kind: 'cancelled' }

/**
 * Evaluates `prelude` (the pm runtime), then `source` wrapped as a function body, with `input` exposed as a frozen
 * JSON global `__input`. The body is an async function, so scripts may use top-level `await`.
 */
export async function runScript(
  prelude: string,
  source: string,
  input: unknown,
  hooks: EngineHooks,
  opts: EngineRunOptions,
): Promise<RunOutput> {
  const cancelled = () =>
    opts.signal?.aborted === true || (opts.cancelFlag !== undefined && Atomics.load(opts.cancelFlag, 0) === 1)
  if (cancelled()) return { result: undefined, logs: [], error: CANCELLED }
  let module: QuickJSWASMModule
  try {
    module = await loadQuickJS()
  } catch (e) {
    compiled = undefined
    discardQuickJS()
    const message = `The script engine failed to start: ${String(e)}`
    return { result: undefined, logs: [], error: { message, kind: 'error' } }
  }
  if (cancelled()) return { result: undefined, logs: [], error: CANCELLED }
  return new Promise((resolve) => new Run(module, hooks, opts, cancelled, resolve).start(prelude, source, input))
}

interface Api {
  start: QuickJSHandle
  fireTimer: QuickJSHandle
  settleSend: QuickJSHandle
  finish: QuickJSHandle
}

class Run {
  private readonly runtime: QuickJSRuntime
  private readonly ctx: QuickJSContext
  private readonly logs: RunOutput['logs'] = []
  private droppedLogs = false
  private api: Api | undefined
  private readonly timers = new Map<number, { handle: NodeJS.Timeout; ms: number }>()
  private pendingSends = 0
  private failure: Failure | undefined
  /** Set when the interrupt handler stopped the VM, so the error it raised is classified by its cause. */
  private interruptedBy: Failure | undefined
  private ended = false
  private cpuUsed = 0
  private sliceStart: number | undefined
  private readonly startedAt = performance.now()
  private wallTimer: NodeJS.Timeout | undefined
  private readonly onAbort = () => this.end(CANCELLED)

  private readonly hooks: EngineHooks
  private readonly opts: EngineRunOptions
  private readonly cancelled: () => boolean
  private readonly resolve: (out: RunOutput) => void

  constructor(
    module: QuickJSWASMModule,
    hooks: EngineHooks,
    opts: EngineRunOptions,
    cancelled: () => boolean,
    resolve: (out: RunOutput) => void,
  ) {
    this.hooks = hooks
    this.opts = opts
    this.cancelled = cancelled
    this.resolve = resolve
    this.runtime = module.newRuntime({
      memoryLimitBytes: opts.memoryBytes,
      maxStackSizeBytes: MAX_STACK_BYTES,
      interruptHandler: () => this.shouldInterrupt(),
    })
    this.runtime.setModuleLoader(
      (name) => ({ error: new Error(`import('${name}') is not supported in Astral Maria`) }),
      (_base, requested) => requested,
    )
    this.ctx = this.runtime.newContext()
  }

  start(prelude: string, source: string, input: unknown): void {
    this.wallTimer = setTimeout(() => this.end(this.wallTimeout()), this.opts.wallMs)
    this.opts.signal?.addEventListener('abort', this.onAbort, { once: true })
    this.step(() => {
      this.api = this.bootstrap(input)
      if (!this.api) return
      if (prelude && !this.evalVoid(prelude, 'prelude.js')) return
      // On the first line, so line numbers in errors match the script's own.
      const main = this.eval(`(async function () {${source}\n})`, 'script.js')
      if (!main) return
      this.call(this.api.start, main)?.dispose()
      main.dispose()
    })
  }

  private shouldInterrupt(): boolean {
    if (this.interruptedBy) return true
    if (this.cancelled()) {
      this.interruptedBy = CANCELLED
    } else if (this.sliceStart !== undefined && this.cpuUsed + performance.now() - this.sliceStart > this.opts.cpuMs) {
      this.interruptedBy = { message: `Script timed out after ${seconds(this.opts.cpuMs)}`, kind: 'timeout' }
    } else if (performance.now() - this.startedAt > this.opts.wallMs) {
      this.interruptedBy = this.wallTimeout()
    }
    return this.interruptedBy !== undefined
  }

  private wallTimeout(): Failure {
    return { message: `Script timed out after ${seconds(this.opts.wallMs)}`, kind: 'timeout' }
  }

  // -- VM access ---------------------------------------------------------------------------------------------------

  /** Runs `fn` in the VM, counting its time against the CPU limit, then drains promise jobs and checks for the end. */
  private step(fn: () => void): void {
    if (this.ended) return
    this.sliceStart = performance.now()
    try {
      fn()
      while (!this.failure) {
        const jobs = this.runtime.executePendingJobs()
        if (jobs.error) {
          this.fail(jobs.error)
          break
        }
        if (jobs.value === 0) break
      }
    } catch (e) {
      // A host-side error from the binding layer, e.g. the wasm instance running out of memory itself.
      this.failure ??= this.interruptedBy ?? this.classifyHostError(e)
    } finally {
      this.cpuUsed += performance.now() - this.sliceStart
      this.sliceStart = undefined
    }
    if (this.failure) this.end(this.failure)
    else if (this.timers.size === 0 && this.pendingSends === 0) this.end(undefined)
  }

  private eval(code: string, filename: string): QuickJSHandle | undefined {
    const result = this.ctx.evalCode(code, filename)
    if (result.error) {
      this.fail(result.error)
      return undefined
    }
    return result.value
  }

  private evalVoid(code: string, filename: string): boolean {
    const handle = this.eval(code, filename)
    handle?.dispose()
    return handle !== undefined
  }

  private call(fn: QuickJSHandle, ...args: QuickJSHandle[]): QuickJSHandle | undefined {
    const result = this.ctx.callFunction(fn, this.ctx.undefined, ...args)
    if (result.error) {
      this.fail(result.error)
      return undefined
    }
    return result.value
  }

  /** Records the first failure; `error` is a VM handle and is disposed here. */
  private fail(error: QuickJSHandle): void {
    const failure = this.interruptedBy ?? this.classify(error)
    if (error.alive) error.dispose()
    this.failure ??= failure
  }

  private classify(error: QuickJSHandle): Failure {
    let dumped: unknown
    try {
      dumped = this.ctx.dump(error)
    } catch {
      return this.memoryFailure()
    }
    const message = describeError(dumped)
    if (/out of memory/i.test(message)) return this.memoryFailure()
    return { message, kind: 'error' }
  }

  private classifyHostError(e: unknown): Failure {
    const text = e instanceof Error ? e.message : String(e)
    if (/out of memory|memory access out of bounds/i.test(text)) return this.memoryFailure()
    return { message: text, kind: 'error' }
  }

  private memoryFailure(): Failure {
    return { message: `Script ran out of memory (limit ${megabytes(this.opts.memoryBytes)})`, kind: 'memory' }
  }

  // -- Host functions ----------------------------------------------------------------------------------------------

  private bootstrap(input: unknown): Api | undefined {
    const ctx = this.ctx
    const factory = this.eval(BOOTSTRAP, 'bootstrap.js')
    if (!factory) return undefined
    const fns = [
      ctx.newFunction('hostLog', (level, text) => {
        this.log(ctx.getString(level) as LogLevel, ctx.getString(text))
      }),
      ctx.newFunction('hostSetTimer', (id, ms) => {
        this.setTimer(ctx.getNumber(id), ctx.getNumber(ms))
      }),
      ctx.newFunction('hostClearTimer', (id) => {
        this.clearTimer(ctx.getNumber(id))
      }),
      ctx.newFunction('hostSend', (id, json) => {
        this.send(ctx.getNumber(id), ctx.getString(json))
      }),
      ctx.newFunction('hostFail', (error) => {
        // The handle is borrowed from the VM's call; classify without disposing it.
        this.failure ??= this.interruptedBy ?? this.classify(error)
      }),
      ctx.newString(JSON.stringify(input) ?? 'null'),
    ]
    const apiHandle = this.call(factory, ...fns)
    factory.dispose()
    for (const fn of fns) fn.dispose()
    if (!apiHandle) return undefined
    const api: Api = {
      start: ctx.getProp(apiHandle, 'start'),
      fireTimer: ctx.getProp(apiHandle, 'fireTimer'),
      settleSend: ctx.getProp(apiHandle, 'settleSend'),
      finish: ctx.getProp(apiHandle, 'finish'),
    }
    apiHandle.dispose()
    return api
  }

  private log(level: LogLevel, text: string): void {
    if (this.logs.length >= MAX_LOG_LINES) {
      if (!this.droppedLogs) {
        this.droppedLogs = true
        this.logs.push({ level: 'warn', text: `Further console output was dropped (limit ${MAX_LOG_LINES} lines)` })
      }
      return
    }
    this.logs.push({ level, text: text.length > MAX_LOG_TEXT ? `${text.slice(0, MAX_LOG_TEXT)}…` : text })
  }

  private setTimer(id: number, ms: number): void {
    const handle = setTimeout(() => this.fireTimer(id), ms)
    this.timers.set(id, { handle, ms })
  }

  private clearTimer(id: number): void {
    const timer = this.timers.get(id)
    if (!timer) return
    clearTimeout(timer.handle)
    this.timers.delete(id)
  }

  private fireTimer(id: number): void {
    const timer = this.timers.get(id)
    if (!timer) return
    this.timers.delete(id)
    this.step(() => {
      const idHandle = this.ctx.newNumber(id)
      const again = this.call(this.api!.fireTimer, idHandle)
      idHandle.dispose()
      if (!again) return
      if (this.ctx.dump(again) === true) this.setTimer(id, timer.ms)
      again.dispose()
    })
  }

  private send(id: number, json: string): void {
    this.pendingSends++
    let sent: Promise<unknown>
    try {
      sent = Promise.resolve(this.hooks.sendRequest(JSON.parse(json)))
    } catch (e) {
      sent = Promise.reject(e)
    }
    sent.then(
        (value) => this.settleSend(id, null, JSON.stringify(value) ?? 'null'),
        (e: unknown) => this.settleSend(id, e instanceof Error ? e.message : String(e), 'null'),
      )
  }

  private settleSend(id: number, errorMessage: string | null, json: string): void {
    if (this.ended) return
    this.pendingSends--
    this.step(() => {
      const ctx = this.ctx
      const error = errorMessage === null ? ctx.null : ctx.newString(errorMessage)
      const args = [ctx.newNumber(id), error, ctx.newString(json)]
      this.call(this.api!.settleSend, ...args)?.dispose()
      for (const arg of args) arg.dispose()
    })
  }

  // -- Ending ------------------------------------------------------------------------------------------------------

  private end(failure: Failure | undefined): void {
    if (this.ended) return
    this.ended = true
    clearTimeout(this.wallTimer)
    this.opts.signal?.removeEventListener('abort', this.onAbort)
    for (const timer of this.timers.values()) clearTimeout(timer.handle)
    this.timers.clear()

    // The runtime collects results even after the script threw, so the tests it recorded before are kept.
    let result: unknown
    if (this.api && (!failure || failure.kind === 'error')) {
      const sliceStart = performance.now()
      this.sliceStart = sliceStart
      try {
        const json = this.call(this.api.finish)
        if (json) {
          const text = this.ctx.dump(json)
          json.dispose()
          if (typeof text === 'string') result = JSON.parse(text)
        }
      } catch (e) {
        this.failure ??= this.interruptedBy ?? this.classifyHostError(e)
      } finally {
        this.sliceStart = undefined
      }
      failure ??= this.failure
    }

    this.dispose()
    const output: RunOutput = { result, logs: this.logs }
    if (failure) output.error = failure
    this.resolve(output)
  }

  private dispose(): void {
    try {
      if (this.api) for (const handle of Object.values(this.api)) if (handle.alive) handle.dispose()
      this.ctx.dispose()
      this.runtime.dispose()
    } catch {
      // A leaked handle or a wasm trap during teardown; do not reuse this wasm instance.
      discardQuickJS()
    }
  }
}

function describeError(value: unknown): string {
  if (typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string') {
    const { name, message } = value as { name?: unknown; message: string }
    return typeof name === 'string' && name !== 'Error' && name !== '' ? `${name}: ${message}` : message
  }
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
