import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Worker } from 'node:worker_threads'
import workerPath from './worker?modulePath'
import type { WorkerInit } from './worker'

// Production wiring of the load workers; tests spawn them with their own ts-loading bootstrap instead.
//
// As for the script sandbox (src/main/scripts/spawn.ts), electron-vite bundles worker.ts on its own (`?modulePath`,
// one CommonJS file, code splitting off) into out/main, which a packaged app keeps inside app.asar. Only the main
// process's fs is sure to read from asar, so main reads the bundle once and each worker evaluates it from a string.

let code: string | undefined

export function spawnLoadWorker(init: WorkerInit): Worker {
  // The wrapper gives the bundle the __filename and __dirname of its real location, and a `require` that resolves
  // from there: code evaluated from a string otherwise resolves bare modules (undici) from the process's cwd.
  if (code === undefined) {
    const bundle = readFileSync(workerPath, 'utf8')
    const file = JSON.stringify(workerPath)
    const args = `require('node:module').createRequire(${file}), ${file}, ${JSON.stringify(dirname(workerPath))}`
    code = `(function (require, __filename, __dirname) {${bundle}\n})(${args})`
  }
  return new Worker(code, { eval: true, workerData: init })
}
