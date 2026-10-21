import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Worker } from 'node:worker_threads'
import wasmPath from '@jitl/quickjs-wasmfile-release-sync/wasm?asset'
import workerPath from './worker?modulePath'
import { ScriptHost } from './host'
import type { WorkerInit } from './worker'

// Production wiring of the sandbox; tests build ScriptHost with their own worker factory instead.
//
// electron-vite bundles worker.ts on its own (`?modulePath`, one CommonJS file: the main build turns code splitting
// off) and emits the QuickJS wasm as an asset (`?asset`). Both land in out/main, which a packaged app keeps inside
// app.asar. Only the main process's fs is sure to read from asar, so main reads both files and hands them over: the
// worker's code is evaluated from a string, and the wasm bytes go in workerData. Nothing needs unpacking.

export function createScriptHost(): ScriptHost {
  let code: string | undefined
  let wasm: Uint8Array | undefined
  return new ScriptHost(() => {
    // The wrapper gives the bundle the __filename and __dirname of its real location.
    if (code === undefined) {
      const bundle = readFileSync(workerPath, 'utf8')
      const args = `${JSON.stringify(workerPath)}, ${JSON.stringify(dirname(workerPath))}`
      code = `(function (__filename, __dirname) {${bundle}\n})(${args})`
    }
    wasm ??= readFileSync(wasmPath)
    return new Worker(code, { eval: true, workerData: { wasm } satisfies WorkerInit })
  })
}
