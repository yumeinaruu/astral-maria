import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { WorkerInit } from '../../src/main/load/worker'

// The load worker entry is TypeScript. As in scriptEngine.test.ts, Node strips the types itself and the hook lets
// its extensionless relative imports (as Vite writes them) resolve to the .ts files.
const workerEntry = fileURLToPath(new URL('../../src/main/load/worker.ts', import.meta.url))
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

export async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Spawns real load workers and keeps track of them, so a test can check that every one exited. */
export function loadWorkers() {
  const spawned: Worker[] = []
  let exited = 0
  return {
    spawn(init: WorkerInit): Worker {
      const worker = new Worker(bootstrap, { eval: true, workerData: init })
      worker.on('exit', () => exited++)
      spawned.push(worker)
      return worker
    },
    get count() {
      return spawned.length
    },
    get exited() {
      return exited
    },
    allExited: () => waitFor(() => spawned.length > 0 && exited === spawned.length),
    terminateAll: () => Promise.all(spawned.map((w) => w.terminate())),
  }
}
