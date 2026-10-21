import type { Worker } from 'node:worker_threads'
import type { EngineHooks, RunOptions, RunOutput } from './engine'
import type { FromWorker, ToWorker } from './worker'

// The main-process side of the script sandbox. One worker serves every run and is spawned on first use. It is
// replaced after a run timed out or ran out of memory (the old one finishes its other runs, then exits), and
// terminated outright when it stops answering: a run still pending `graceMs` after its wall limit, or after it was
// cancelled, fails without waiting for the worker.

export interface ScriptHostOptions {
  /** How long past a run's wall limit, or past cancelling it, the worker may take to answer. */
  graceMs?: number
}

interface Slot {
  worker: Worker
  runs: Set<number>
  retired: boolean
}

interface PendingRun {
  slot: Slot
  hooks: EngineHooks
  opts: RunOptions
  cancel: Int32Array
  watchdog: NodeJS.Timeout
  cleanup(): void
  resolve(out: RunOutput): void
}

const DEFAULT_GRACE_MS = 2000

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`
const failed = (message: string, kind: NonNullable<RunOutput['error']>['kind']): RunOutput => ({
  result: undefined,
  logs: [],
  error: { message, kind },
})

export class ScriptHost {
  private readonly createWorker: () => Worker
  private readonly graceMs: number
  private current: Slot | undefined
  private readonly slots = new Set<Slot>()
  private readonly runs = new Map<number, PendingRun>()
  private nextId = 0
  private disposed = false

  constructor(createWorker: () => Worker, options: ScriptHostOptions = {}) {
    this.createWorker = createWorker
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  }

  run(prelude: string, source: string, input: unknown, hooks: EngineHooks, opts: RunOptions): Promise<RunOutput> {
    if (this.disposed || opts.signal?.aborted) return Promise.resolve(failed('Script was cancelled', 'cancelled'))
    const slot = this.slot()
    const id = ++this.nextId
    const cancelBuffer = new SharedArrayBuffer(4)
    return new Promise<RunOutput>((resolve) => {
      const onAbort = () => {
        Atomics.store(pending.cancel, 0, 1)
        slot.worker.postMessage({ type: 'abort', id } satisfies ToWorker)
        clearTimeout(pending.watchdog)
        const cancelled = failed('Script was cancelled', 'cancelled')
        pending.watchdog = setTimeout(() => this.stuck(slot, id, cancelled), this.graceMs)
      }
      const pending: PendingRun = {
        slot,
        hooks,
        opts,
        cancel: new Int32Array(cancelBuffer),
        watchdog: setTimeout(
          () => this.stuck(slot, id, failed(`Script timed out after ${seconds(opts.wallMs)}`, 'timeout')),
          opts.wallMs + this.graceMs,
        ),
        cleanup: () => opts.signal?.removeEventListener('abort', onAbort),
        resolve,
      }
      this.runs.set(id, pending)
      slot.runs.add(id)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      const { cpuMs, wallMs, memoryBytes } = opts
      const limits = { cpuMs, wallMs, memoryBytes }
      const message: ToWorker = { type: 'run', id, prelude, source, input, opts: limits, cancel: cancelBuffer }
      try {
        slot.worker.postMessage(message)
      } catch (e) {
        this.settle(id, failed(`The script input could not be passed to the sandbox: ${String(e)}`, 'error'))
      }
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const id of [...this.runs.keys()]) this.settle(id, failed('Script was cancelled', 'cancelled'))
    const slots = [...this.slots]
    this.slots.clear()
    this.current = undefined
    await Promise.all(slots.map((slot) => slot.worker.terminate()))
  }

  private slot(): Slot {
    if (this.current && !this.current.retired) return this.current
    const worker = this.createWorker()
    const slot: Slot = { worker, runs: new Set(), retired: false }
    worker.on('message', (msg: FromWorker) => this.onMessage(slot, msg))
    const lost = (message: string) => {
      this.forget(slot)
      for (const id of [...slot.runs]) this.settle(id, failed(message, 'error'))
    }
    worker.on('error', (e) => lost(`The script sandbox failed: ${e instanceof Error ? e.message : String(e)}`))
    worker.on('exit', () => lost('The script sandbox stopped unexpectedly'))
    this.slots.add(slot)
    this.current = slot
    return slot
  }

  private onMessage(slot: Slot, msg: FromWorker): void {
    const pending = this.runs.get(msg.id)
    if (!pending || pending.slot !== slot) return
    if (msg.type === 'done') {
      this.settle(msg.id, msg.output)
      const kind = msg.output.error?.kind
      if (kind === 'timeout' || kind === 'memory') this.retire(slot)
      return
    }
    const reply = (result: { ok: true; value: unknown } | { ok: false; message: string }) => {
      if (!this.runs.has(msg.id)) return
      try {
        slot.worker.postMessage({ type: 'sendResult', id: msg.id, reqId: msg.reqId, ...result } satisfies ToWorker)
      } catch (e) {
        const message = `The response could not be passed to the script: ${String(e)}`
        const failure: ToWorker = { type: 'sendResult', id: msg.id, reqId: msg.reqId, ok: false, message }
        slot.worker.postMessage(failure)
      }
    }
    let sent: Promise<unknown>
    try {
      sent = Promise.resolve(pending.hooks.sendRequest(msg.raw))
    } catch (e) {
      sent = Promise.reject(e)
    }
    sent.then(
      (value) => reply({ ok: true, value }),
      (e: unknown) => reply({ ok: false, message: e instanceof Error ? e.message : String(e) }),
    )
  }

  private settle(id: number, output: RunOutput): void {
    const pending = this.runs.get(id)
    if (!pending) return
    this.runs.delete(id)
    pending.slot.runs.delete(id)
    clearTimeout(pending.watchdog)
    pending.cleanup()
    pending.resolve(output)
    if (pending.slot.retired && pending.slot.runs.size === 0) this.terminate(pending.slot)
  }

  /** New runs go to a fresh worker; this one exits once its runs are done. */
  private retire(slot: Slot): void {
    slot.retired = true
    if (this.current === slot) this.current = undefined
    if (slot.runs.size === 0) this.terminate(slot)
  }

  /** The worker did not answer in time: fail this run, and the worker's other runs with it, and replace it. */
  private stuck(slot: Slot, id: number, output: RunOutput): void {
    this.forget(slot)
    this.settle(id, output)
    const restarted = failed('Script stopped: the script sandbox was restarted', 'error')
    for (const other of [...slot.runs]) this.settle(other, restarted)
    void slot.worker.terminate()
  }

  private terminate(slot: Slot): void {
    this.forget(slot)
    void slot.worker.terminate()
  }

  private forget(slot: Slot): void {
    slot.retired = true
    this.slots.delete(slot)
    if (this.current === slot) this.current = undefined
  }
}
