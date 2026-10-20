import * as fs from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import * as path from 'node:path'

export class CorruptFileError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(message)
    this.name = 'CorruptFileError'
  }
}

const CONFLICT_MARKER = /^(<<<<<<<|=======|>>>>>>>)/m

/**
 * Reads and parses a JSON file. `label` (default: `filePath`) names the file in error messages, which never quote
 * any of its content: a hand-edited `.local` file holds plain current values.
 */
export async function readJson<T>(filePath: string, label: string = filePath): Promise<T> {
  return parseJson<T>(await fs.readFile(filePath, 'utf8'), filePath, label)
}

/** The revision of a file: the sha256 (hex) of its bytes. */
export function revisionOf(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Like `readJson`, also returning the revision of the exact bytes that were parsed. */
export async function readJsonWithRevision<T>(
  filePath: string,
  label: string = filePath
): Promise<{ data: T; revision: string }> {
  const bytes = await fs.readFile(filePath)
  return { data: parseJson<T>(bytes.toString('utf8'), filePath, label), revision: revisionOf(bytes) }
}

function parseJson<T>(text: string, filePath: string, label: string): T {
  if (CONFLICT_MARKER.test(text)) {
    throw new CorruptFileError(filePath, `File contains merge conflict markers: ${label}`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    // V8's message quotes a snippet of the text, so the position is computed here instead.
    const offset = jsonErrorOffset(text)
    const where = offset === null ? '' : ` (${lineAndColumn(text, offset)})`
    throw new CorruptFileError(filePath, `Invalid JSON in ${label}${where}`)
  }
}

function lineAndColumn(text: string, offset: number): string {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  return `line ${line}, column ${offset - before.lastIndexOf('\n')}`
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])
const ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't'])

class SyntaxAt {
  constructor(readonly offset: number) {}
}

/** The offset of the first JSON syntax error in `text`, or null if none is found. Only used once parsing failed. */
export function jsonErrorOffset(text: string): number | null {
  let i = 0
  const fail = (): never => {
    throw new SyntaxAt(i)
  }
  const ws = (): void => {
    while (i < text.length && WHITESPACE.has(text[i])) i++
  }
  const digits = (): void => {
    if (!/[0-9]/.test(text[i] ?? '')) fail()
    while (/[0-9]/.test(text[i] ?? '')) i++
  }
  const literal = (word: string): void => {
    for (const ch of word) {
      if (text[i] !== ch) fail()
      i++
    }
  }
  const string = (): void => {
    if (text[i] !== '"') fail()
    i++
    for (;;) {
      if (i >= text.length) fail()
      const ch = text[i]
      if (ch === '"') {
        i++
        return
      }
      if (ch === '\\') {
        i++
        if (text[i] === 'u') {
          i++
          for (let k = 0; k < 4; k++, i++) if (!/[0-9a-fA-F]/.test(text[i] ?? '')) fail()
          continue
        }
        if (!ESCAPES.has(text[i] ?? '')) fail()
      } else if (ch.charCodeAt(0) < 0x20) {
        fail()
      }
      i++
    }
  }
  const number = (): void => {
    if (text[i] === '-') i++
    if (text[i] === '0') i++
    else digits()
    if (text[i] === '.') {
      i++
      digits()
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++
      if (text[i] === '+' || text[i] === '-') i++
      digits()
    }
  }
  const value = (): void => {
    ws()
    const ch = text[i]
    if (ch === '{') {
      i++
      ws()
      if (text[i] === '}') {
        i++
        return
      }
      for (;;) {
        ws()
        string()
        ws()
        if (text[i] !== ':') fail()
        i++
        value()
        ws()
        if (text[i] === '}') {
          i++
          return
        }
        if (text[i] !== ',') fail()
        i++
      }
    } else if (ch === '[') {
      i++
      ws()
      if (text[i] === ']') {
        i++
        return
      }
      for (;;) {
        value()
        ws()
        if (text[i] === ']') {
          i++
          return
        }
        if (text[i] !== ',') fail()
        i++
      }
    } else if (ch === '"') {
      string()
    } else if (ch === '-' || /[0-9]/.test(ch ?? '')) {
      number()
    } else if (ch === 't') {
      literal('true')
    } else if (ch === 'f') {
      literal('false')
    } else if (ch === 'n') {
      literal('null')
    } else {
      fail()
    }
  }
  try {
    value()
    ws()
    return i < text.length ? i : null
  } catch (e) {
    // A RangeError means the nesting is too deep to scan; then there is no position to report.
    return e instanceof SyntaxAt ? e.offset : null
  }
}

/** Writes `data` as JSON (temp file, then rename) and returns the revision of the written bytes. */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<string> {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)
  const text = JSON.stringify(data, null, 2) + '\n'
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, filePath)
    return revisionOf(text)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}

export function resolveInside(root: string, relativePath: string): string {
  const rootAbs = path.resolve(root)
  const rel = relativePath.replace(/\\/g, '/')
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new Error('path_outside_workspace')
  const result = path.resolve(rootAbs, rel)
  if (result !== rootAbs && !result.startsWith(rootAbs + path.sep)) throw new Error('path_outside_workspace')
  return result
}
