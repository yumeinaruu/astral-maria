import chaiSource from 'chai/index.js?raw'
import nodeSource from './runtime/node.js?raw'
import pmSource from './runtime/pm.js?raw'

// The prelude the engine evaluates before every script: chai, then the pm runtime and its Node-style helpers, inside one function scope so
// neither chai nor the runtime's helpers become globals. Only what pm.js installs on globalThis is visible.
//
// chai ships one self-contained ESM bundle (index.js, built by esbuild, no imports). QuickJS evaluates the prelude
// as a classic script, without a module loader, so the bundle's trailing `export { ... }` is rewritten into a
// returned object and the bundle runs as a function body.
//
// chai's plugin hooks (`util.events`) use the DOM's EventTarget and Event, which QuickJS lacks. Minimal local
// stand-ins are declared in the bundle's own scope; they are not globals.

const EVENT_SHIM = `
class Event {
  constructor(type) { this.type = type }
}
class EventTarget {
  #listeners = new Map()
  addEventListener(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, [])
    this.#listeners.get(type).push(fn)
  }
  removeEventListener(type, fn) {
    const list = this.#listeners.get(type)
    if (list) this.#listeners.set(type, list.filter((f) => f !== fn))
  }
  dispatchEvent(event) {
    for (const fn of this.#listeners.get(event.type) ?? []) fn.call(this, event)
    return true
  }
}
`

const EXPORT = /\bexport\s*\{([^}]*)\};?\s*$/

/** Turns chai's ESM bundle into an expression that evaluates to its exports. */
export function chaiAsExpression(source: string): string {
  const match = EXPORT.exec(source)
  if (!match) throw new Error('chai: the bundle has no trailing export list')
  if (/^\s*import\b|\bimport\s*\(|\bimport\.meta\b/m.test(source.slice(0, match.index))) {
    throw new Error('chai: the bundle is expected to have no imports')
  }
  const entries = match[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const [local, exported = local] = part.split(/\s+as\s+/)
      return `${exported}: ${local}`
    })
  return `(function () {\n${EVENT_SHIM}\n${source.slice(0, match.index)}\nreturn { ${entries.join(', ')} }\n})()`
}

export const PRELUDE = `(function () {\n'use strict'\nconst chai = ${chaiAsExpression(chaiSource)}\n${pmSource}\n${nodeSource}\n})()\n`
