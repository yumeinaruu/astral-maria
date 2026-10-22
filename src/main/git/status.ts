// The state of a workspace's repository, read from `git status --porcelain=v2 --branch -z`. Paths under `.local/`
// (secrets and per-machine state) are never listed, even when `.gitignore` no longer hides them.

import { access } from 'node:fs/promises'
import * as path from 'node:path'
import { GitError, runGit, stripCredentials } from './git'

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed'

export interface GitChange {
  path: string
  kind: ChangeKind
  /** The old path of a rename. */
  from?: string
}

export interface GitStatus {
  repo: boolean
  /** null when HEAD is detached. */
  branch: string | null
  /** e.g. `origin/main`. */
  upstream: string | null
  /** origin's fetch URL, credentials stripped. */
  remoteUrl: string | null
  ahead: number
  behind: number
  /** Sorted by path; `.local/` is never listed, and neither are conflicted paths. */
  changes: GitChange[]
  /** MERGE_HEAD exists. */
  merging: boolean
  conflicted: string[]
}

const NOT_A_REPO: GitStatus = {
  repo: false,
  branch: null,
  upstream: null,
  remoteUrl: null,
  ahead: 0,
  behind: 0,
  changes: [],
  merging: false,
  conflicted: []
}

/** Whether a repo-relative path is the workspace's `.local/` directory or inside it. */
export function isLocalPath(p: string): boolean {
  return p === '.local' || p.startsWith('.local/')
}

export async function readStatus(dir: string): Promise<GitStatus> {
  const args = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']
  let porcelain: string
  try {
    ;({ stdout: porcelain } = await runGit(dir, args))
  } catch (e) {
    if (e instanceof GitError && e.code === 'not_a_repo') return { ...NOT_A_REPO, changes: [], conflicted: [] }
    throw e
  }
  const [remoteUrl, merging] = await Promise.all([readRemoteUrl(dir), isMerging(dir)])
  return { ...parsePorcelain(porcelain), repo: true, remoteUrl, merging }
}

async function readRemoteUrl(dir: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(dir, ['remote', 'get-url', 'origin'])
    return stripCredentials(stdout.trim()) || null
  } catch (e) {
    if (e instanceof GitError && e.code === 'failed') return null // no origin
    throw e
  }
}

async function isMerging(dir: string): Promise<boolean> {
  const { stdout } = await runGit(dir, ['rev-parse', '--git-path', 'MERGE_HEAD'])
  try {
    await access(path.resolve(dir, stdout.trim()))
    return true
  } catch {
    return false
  }
}

type Parsed = Omit<GitStatus, 'repo' | 'remoteUrl' | 'merging'>

/** Splits off the first `count` space-separated fields; the rest of the record is the path, spaces and all. */
function fieldsAndPath(record: string, count: number): { fields: string[]; path: string } {
  const fields: string[] = []
  let rest = record
  for (let i = 0; i < count; i++) {
    const space = rest.indexOf(' ')
    fields.push(rest.slice(0, space))
    rest = rest.slice(space + 1)
  }
  return { fields, path: rest }
}

/** The kind of an ordinary (`1`) entry from its XY status, or null when it adds up to no change. */
function ordinaryKind(xy: string): ChangeKind | null {
  const [x, y] = xy
  if (x === 'A' && y === 'D') return null // added to the index, then deleted from the working tree
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A') return 'added'
  return 'modified'
}

export function parsePorcelain(output: string): Parsed {
  const result: Parsed = { branch: null, upstream: null, ahead: 0, behind: 0, changes: [], conflicted: [] }
  const records = output.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record === '') continue
    if (record.startsWith('# ')) {
      const [, key, ...values] = record.split(' ')
      const value = values.join(' ')
      if (key === 'branch.head') result.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') result.upstream = value
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match) {
          result.ahead = Number(match[1])
          result.behind = Number(match[2])
        }
      }
      continue
    }
    switch (record[0]) {
      case '1': {
        const { fields, path: p } = fieldsAndPath(record, 8)
        const kind = ordinaryKind(fields[1])
        if (kind !== null) result.changes.push({ path: p, kind })
        break
      }
      case '2': {
        const { fields, path: p } = fieldsAndPath(record, 9)
        const from = records[++i] // the original path follows as its own record
        if (fields[8].startsWith('C') || isLocalPath(from)) result.changes.push({ path: p, kind: 'added' })
        else result.changes.push({ path: p, kind: 'renamed', from })
        break
      }
      case 'u':
        result.conflicted.push(fieldsAndPath(record, 10).path)
        break
      case '?':
        result.changes.push({ path: record.slice(2), kind: 'added' })
        break
      default:
        break // `!` (ignored) is not requested
    }
  }
  result.changes = result.changes.filter((c) => !isLocalPath(c.path)).sort((a, b) => compare(a.path, b.path))
  result.conflicted = result.conflicted.filter((p) => !isLocalPath(p)).sort(compare)
  return result
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
