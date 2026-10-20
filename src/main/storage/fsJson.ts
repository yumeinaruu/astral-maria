import * as fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
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

export async function readJson<T>(filePath: string): Promise<T> {
  const text = await fs.readFile(filePath, 'utf8')
  if (CONFLICT_MARKER.test(text)) {
    throw new CorruptFileError(filePath, `File contains merge conflict markers: ${filePath}`)
  }
  try {
    return JSON.parse(text) as T
  } catch (e) {
    throw new CorruptFileError(filePath, `Invalid JSON in ${filePath}: ${(e as Error).message}`)
  }
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, filePath)
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
