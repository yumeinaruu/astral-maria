// Pure helpers shared by the git sync in main and the Sync UI: the kind of a workspace file, the commit message the
// Commit dialog starts from, and the messages the renderer recognises (error codes do not survive IPC).

import type { SyncChange } from './types'

export type FileKind = 'request' | 'folder' | 'collection' | 'environment' | 'workspace' | 'other'

/** The message of the `identity_missing` error: git has no `user.name` / `user.email` for this repository. */
export const IDENTITY_MISSING_MESSAGE = 'Git needs your name and email before it can commit'

/** `git.resolve` with `edited` on a file that still has conflict markers or does not parse. */
export function notResolvedMessage(label: string): string {
  return `${label} still has conflict markers or is not valid JSON`
}

/** The kind of a workspace file, by its workspace-relative path. */
export function fileKind(relPath: string): FileKind {
  const rel = relPath.replace(/\\/g, '/')
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  if (name.endsWith('.request.json')) return 'request'
  if (name === 'folder.json') return 'folder'
  if (name === 'collection.json') return 'collection'
  if (/^environments\/[^/]+\.json$/.test(rel)) return 'environment'
  if (rel === 'workspace.json') return 'workspace'
  return 'other'
}

const GLOBALS_FILE = 'environments/globals.json'

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
