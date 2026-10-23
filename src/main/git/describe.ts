// Human-readable names for changed and conflicted workspace files, and the commit message the Commit dialog starts
// from. Names come from the files' JSON `name`; a file that cannot be read is shown by its path.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { SyncChange } from '../../shared/types'
import { fileKind } from '../../shared/syncText'
import type { GitChange } from './status'

/** Reads a workspace-relative file's text, or null when it does not exist there. */
export type Reader = (relPath: string) => Promise<string | null>

const GLOBALS_FILE = 'environments/globals.json'

async function nameIn(read: Reader, relPath: string): Promise<string | null> {
  const text = await read(relPath)
  if (text === null) return null
  try {
    const data: unknown = JSON.parse(text)
    if (typeof data === 'object' && data !== null && typeof (data as { name?: unknown }).name === 'string') {
      return (data as { name: string }).name
    }
  } catch {
    // Invalid JSON (or conflict markers): no name.
  }
  return null
}

/** `collections/<slug>/...` -> `collections/<slug>`; null outside a collection. */
function collectionDir(relPath: string): string | null {
  const parts = relPath.split('/')
  return parts[0] === 'collections' && parts.length > 2 ? `${parts[0]}/${parts[1]}` : null
}

/** The label of one file, e.g. `Request "Login user" in Auth API`; the path when its name cannot be read. */
export async function labelFor(relPath: string, read: Reader): Promise<string> {
  const kind = fileKind(relPath)
  if (kind === 'workspace') return 'Workspace settings'
  if (kind === 'environment' && relPath === GLOBALS_FILE) return 'Globals'
  if (kind === 'other') return relPath
  const name = await nameIn(read, relPath)
  if (name === null) return relPath
  switch (kind) {
    case 'request': {
      const collection = collectionDir(relPath)
      if (collection === null) return `Request "${name}"`
      const collectionName = (await nameIn(read, `${collection}/collection.json`)) ?? path.posix.basename(collection)
      return `Request "${name}" in ${collectionName}`
    }
    case 'folder':
      return `Folder "${name}"`
    case 'collection':
      return `Collection "${name}"`
    case 'environment':
      return `Environment "${name}"`
  }
}

/**
 * Labels `changes`. Names are read from the working tree; a file that is gone or unreadable there (a deletion, a
 * file with conflict markers) is read from HEAD through `readHead`.
 */
export async function describeChanges(
  dir: string,
  changes: GitChange[],
  readHead: (relPath: string) => Promise<string | null>,
): Promise<SyncChange[]> {
  const read: Reader = async (relPath) => {
    try {
      const text = await fs.readFile(path.join(dir, relPath), 'utf8')
      JSON.parse(text)
      return text
    } catch {
      return readHead(relPath)
    }
  }
  const out: SyncChange[] = []
  for (const change of changes) {
    out.push({ path: change.path, kind: change.kind, label: await labelFor(change.path, read) })
  }
  return out
}

export { defaultCommitMessage } from '../../shared/syncText'
