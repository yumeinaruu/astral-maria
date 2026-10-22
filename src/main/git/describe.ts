// Human-readable names for changed and conflicted workspace files, and the commit message the Commit dialog starts
// from. Names come from the files' JSON `name`; a file that cannot be read is shown by its path.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { SyncChange } from '../../shared/types'
import { fileKind } from './jsonMerge'
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

type Group = 'request' | 'folder' | 'collection' | 'environment' | 'globals' | 'workspace' | 'file'

const GROUPS: { group: Group; one: string; many: string; counted: boolean }[] = [
  { group: 'request', one: 'request', many: 'requests', counted: true },
  { group: 'folder', one: 'folder', many: 'folders', counted: true },
  { group: 'collection', one: 'collection', many: 'collections', counted: true },
  { group: 'environment', one: 'environment', many: 'environments', counted: true },
  { group: 'globals', one: 'globals', many: 'globals', counted: false },
  { group: 'workspace', one: 'workspace settings', many: 'workspace settings', counted: false },
  { group: 'file', one: 'file', many: 'files', counted: true },
]

function groupOf(relPath: string): Group {
  const kind = fileKind(relPath)
  if (kind === 'environment' && relPath === GLOBALS_FILE) return 'globals'
  if (kind === 'other') return 'file'
  return kind
}

const VERBS: Record<SyncChange['kind'], string> = {
  added: 'Add',
  deleted: 'Delete',
  renamed: 'Rename',
  modified: 'Update',
}

/** E.g. `Update 2 requests and 1 environment`; `Add` / `Delete` / `Rename` when every change is of that kind. */
export function defaultCommitMessage(changes: SyncChange[]): string {
  if (changes.length === 0) return 'Update workspace'
  const kinds = new Set(changes.map((c) => c.kind))
  const verb = kinds.size === 1 ? VERBS[changes[0].kind] : 'Update'
  const counts = new Map<Group, number>()
  for (const c of changes) counts.set(groupOf(c.path), (counts.get(groupOf(c.path)) ?? 0) + 1)
  const parts = GROUPS.filter((g) => counts.has(g.group)).map((g) => {
    const n = counts.get(g.group) ?? 0
    const noun = n === 1 ? g.one : g.many
    return g.counted ? `${n} ${noun}` : noun
  })
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `${verb} ${list}`
}
