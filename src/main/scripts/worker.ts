import { parentPort, workerData } from 'node:worker_threads'
import { configureEngine, runScript, type EngineHooks, type RunOutput } from './engine'

// The worker_threads entry: runs scripts with the engine on behalf of ScriptHost. Several runs may be in flight;
// each has its own QuickJS runtime. Only plain data crosses the thread boundary.

export interface WorkerInit {
  /** The QuickJS wasm, read by the main process. */
  wasm?: Uint8Array
}

export type ToWorker =
  | {
      type: 'run'
      id: number
      prelude: string
      source: string
      input: unknown
      opts: { cpuMs: number; wallMs: number; memoryBytes: number }
      /** A 4-byte SharedArrayBuffer; the host stores 1 in it to cancel a busy script. */
      cancel: SharedArrayBuffer
    }
  | { type: 'abort'; id: number }
  | { type: 'sendResult'; id: number; reqId: number; ok: true; value: unknown }
  | { type: 'sendResult'; id: number; reqId: number; ok: false; message: string }

export type FromWorker =
  | { type: 'send'; id: number; reqId: number; raw: unknown }
  | { type: 'done'; id: number; output: RunOutput }

const port = parentPort
if (!port) throw new Error('The script worker must run in a worker thread')

const init = workerData as WorkerInit | undefined
if (init?.wasm) configureEngine({ wasm: init.wasm })

interface ActiveRun {
  controller: AbortController
  sends: Map<number, { resolve(value: unknown): void; reject(e: Error): void }>
}
const runs = new Map<number, ActiveRun>()

const post = (msg: FromWorker) => port.postMessage(msg)

port.on('message', (msg: ToWorker) => {
  switch (msg.type) {
    case 'run': {
      const active: ActiveRun = { controller: new AbortController(), sends: new Map() }
      runs.set(msg.id, active)
      let nextReq = 0
      const hooks: EngineHooks = {
        sendRequest: (raw) =>
          new Promise((resolve, reject) => {
            const reqId = ++nextReq
            active.sends.set(reqId, { resolve, reject })
            post({ type: 'send', id: msg.id, reqId, raw })
          }),
      }
      const opts = { ...msg.opts, signal: active.controller.signal, cancelFlag: new Int32Array(msg.cancel) }
      runScript(msg.prelude, msg.source, msg.input, hooks, opts)
        .catch((e: unknown): RunOutput => ({
          result: undefined,
          logs: [],
          error: { message: String(e), kind: 'error' },
        }))
        .then((output) => {
          runs.delete(msg.id)
          post({ type: 'done', id: msg.id, output })
        })
      break
    }
    case 'abort':
      runs.get(msg.id)?.controller.abort()
      break
    case 'sendResult': {
      const pending = runs.get(msg.id)?.sends
      const send = pending?.get(msg.reqId)
      if (!send) break
      pending!.delete(msg.reqId)
      if (msg.ok) send.resolve(msg.value)
      else send.reject(new Error(msg.message))
      break
    }
  }
})
