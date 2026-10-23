// Linking a workspace to a repository and syncing it: commit, fetch, merge, push. A merge that stops is settled file
// by file with the field-level JSON merge; what is left goes to the user as conflict items, kept in
// `.git/astral-merge.json` so they survive a restart.
//
// The workspace folder itself must be the repository's top level. A workspace inside another repository (a folder in
// a project checkout) is reported as not linked, and `link` creates a repository of its own in the workspace folder
// rather than adopting the enclosing one.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { IDENTITY_MISSING_MESSAGE, notResolvedMessage } from '../../shared/syncText'
import type { SyncChoice, SyncConflictItem, SyncOutcome, SyncState } from '../../shared/types'
import { readJson, writeJsonAtomic } from '../storage/fsJson'
import { ensureGitignore } from '../storage/workspaceStore'
import { describeChanges, labelFor, type Reader } from './describe'
import { GitError, runGit } from './git'
import { applyChoices, fileKind, mergeJson, type FieldConflict, type FileKind } from './jsonMerge'
import { isLocalPath, readStatus } from './status'

export const MERGING_MESSAGE = 'Finish or abort the merge first'
const NOT_LINKED_MESSAGE = 'This workspace is not linked to a git repository. Set up sync first'
const NOT_A_REPO_MESSAGE = 'This workspace is not a git repository yet. Set up sync first'
/** The commit `link` makes of a workspace that has none before merging the remote into it. */
const INITIAL_MESSAGE = 'Add workspace'
const RECORD_FILE = 'astral-merge.json'
const SHORT_TEXT = 200

type Operation = 'sync' | 'pull' | 'link'

type StoredItem =
  | { kind: 'fields'; label: string; fileKind: FileKind; partial: unknown; conflicts: FieldConflict[] }
  | { kind: 'file' | 'deleted_remote' | 'deleted_local'; label: string }

/** What a stopped merge left for the user; `.git/astral-merge.json`. */
interface MergeRecord {
  version: 1
  operation: Operation
  /** Commits the merge brings in, reported when it finishes. */
  pulled: number
  items: Record<string, StoredItem>
}

const NOT_LINKED: SyncState = {
  linked: false,
  branch: null,
  remoteUrl: null,
  ahead: 0,
  behind: 0,
  changes: [],
  merging: false,
  conflicts: [],
  identity: null,
}

// --- small git helpers -----------------------------------------------------------------------------------------

const git = (dir: string, args: string[], input?: string) =>
  runGit(dir, args, input === undefined ? {} : { input }).then((r) => r.stdout)

/** Paths are passed as literal pathspecs, so `*` or `:` in a file name is not a pattern. */
const gitPaths = (dir: string, args: string[], paths: string[]) =>
  git(dir, ['--literal-pathspecs', ...args, '--', ...paths])

/** Resolves whether the command exits 0; any GitError counts as no. */
async function succeeds(dir: string, args: string[]): Promise<boolean> {
  try {
    await git(dir, args)
    return true
  } catch (e) {
    if (e instanceof GitError && (e.code === 'failed' || e.code === 'not_a_repo')) return false
    throw e
  }
}

/** The output, or null when the command fails (a missing revision or path). */
async function outputOrNull(dir: string, args: string[]): Promise<string | null> {
  try {
    return await git(dir, args)
  } catch (e) {
    if (e instanceof GitError && e.code === 'failed') return null
    throw e
  }
}

const nulSplit = (text: string) => text.split('\0').filter((s) => s !== '')

async function count(dir: string, args: string[]): Promise<number> {
  return Number((await git(dir, ['rev-list', '--count', ...args])).trim())
}

const remoteRef = (branch: string) => `refs/remotes/origin/${branch}`
const hasHead = (dir: string) => succeeds(dir, ['rev-parse', '--quiet', '--verify', 'HEAD^{commit}'])
const refExists = (dir: string, ref: string) => succeeds(dir, ['rev-parse', '--quiet', '--verify', `${ref}^{commit}`])
const isMerging = (dir: string) => succeeds(dir, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'])

async function currentBranch(dir: string): Promise<string | null> {
  return (await outputOrNull(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim() || null
}

/** Whether `dir` is the top level of a repository (not a folder inside an enclosing one). */
export async function isOwnRepo(dir: string): Promise<boolean> {
  let top: string
  try {
    top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
  } catch (e) {
    if (e instanceof GitError && (e.code === 'not_a_repo' || e.code === 'failed')) return false
    throw e
  }
  const [a, b] = await Promise.all([fs.realpath(top), fs.realpath(dir)])
  return a === b
}

/** origin's URL as configured (credentials included: it is passed back to git, never shown). */
const originUrl = async (dir: string) => (await outputOrNull(dir, ['remote', 'get-url', 'origin']))?.trim() || null

async function readIdentity(dir: string): Promise<{ name: string; email: string } | null> {
  const [name, email] = await Promise.all(
    ['user.name', 'user.email'].map(async (key) => (await outputOrNull(dir, ['config', '--get', key]))?.trim() ?? ''),
  )
  return name && email ? { name, email } : null
}

async function requireIdentity(dir: string): Promise<void> {
  if ((await readIdentity(dir)) === null) throw new GitError('identity_missing', IDENTITY_MISSING_MESSAGE, '')
}

async function requireRepo(dir: string): Promise<void> {
  if (!(await isOwnRepo(dir))) throw new GitError('not_a_repo', NOT_A_REPO_MESSAGE, '')
}

async function requireLinked(dir: string): Promise<void> {
  if (!(await isOwnRepo(dir)) || (await originUrl(dir)) === null) {
    throw new GitError('failed', NOT_LINKED_MESSAGE, '')
  }
}

async function requireNotMerging(dir: string): Promise<void> {
  if (await isMerging(dir)) throw new GitError('conflict', MERGING_MESSAGE, '')
}

async function requireBranch(dir: string): Promise<string> {
  const branch = await currentBranch(dir)
  if (branch === null) throw new GitError('failed', 'Check out a branch first: the workspace is on a detached HEAD', '')
  return branch
}

function validUrl(url: unknown): string {
  const text = typeof url === 'string' ? url.trim() : ''
  if (text === '' || text.startsWith('-') || /[\0\r\n]/.test(text)) throw new Error('Enter a repository URL')
  return text
}

// --- the merge record ------------------------------------------------------------------------------------------

async function recordPath(dir: string): Promise<string> {
  return path.resolve(dir, (await git(dir, ['rev-parse', '--git-path', RECORD_FILE])).trim())
}

async function readRecord(dir: string): Promise<MergeRecord | null> {
  try {
    const record = await readJson<MergeRecord>(await recordPath(dir))
    return record?.version === 1 && typeof record.items === 'object' && record.items !== null ? record : null
  } catch {
    return null
  }
}

async function deleteRecord(dir: string): Promise<void> {
  await fs.rm(await recordPath(dir), { force: true })
}

// --- state -----------------------------------------------------------------------------------------------------

/** HEAD's version of a file, for labels of deleted files. */
const headReader = (dir: string) => (relPath: string) => outputOrNull(dir, ['show', `HEAD:${relPath}`])

/** During a merge: the first version of a file that parses (the index, ours, theirs, base), for labels. */
function stageReader(dir: string): Reader {
  return async (relPath) => {
    for (const stage of [0, 2, 3, 1]) {
      const text = await outputOrNull(dir, ['show', `:${stage}:${relPath}`])
      if (text === null) continue
      try {
        JSON.parse(text)
        return text
      } catch {
        // Try the next version.
      }
    }
    return null
  }
}

async function aheadBehind(dir: string, branch: string | null): Promise<{ ahead: number; behind: number }> {
  const ref = branch === null ? null : remoteRef(branch)
  const remote = ref !== null && (await refExists(dir, ref))
  if (!(await hasHead(dir))) return { ahead: 0, behind: remote && ref ? await count(dir, [ref]) : 0 }
  if (remote && ref) {
    const [ahead, behind] = (await git(dir, ['rev-list', '--left-right', '--count', `HEAD...${ref}`]))
      .trim()
      .split(/\s+/)
      .map(Number)
    return { ahead, behind }
  }
  return { ahead: await count(dir, ['HEAD', '--not', '--remotes=origin']), behind: 0 }
}

function shortText(value: unknown): string {
  const text = value === undefined ? '(none)' : typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > SHORT_TEXT ? `${text.slice(0, SHORT_TEXT - 1)}…` : text
}

function toItem(id: string, stored: StoredItem): SyncConflictItem {
  if (stored.kind !== 'fields') return { id, label: stored.label, kind: stored.kind }
  return {
    id,
    label: stored.label,
    kind: 'fields',
    fields: stored.conflicts.map((c) => ({
      path: c.path,
      label: c.label,
      ours: shortText(c.ours),
      theirs: shortText(c.theirs),
    })),
  }
}

/** The index stages (1 base, 2 ours, 3 theirs) of an unmerged path. */
async function stagesOf(dir: string, relPath: string): Promise<Set<number>> {
  const out = await gitPaths(dir, ['ls-files', '--unmerged', '-z'], [relPath])
  return new Set(nulSplit(out).map((record) => Number(record.split('\t')[0].split(' ')[2])))
}

/** A conflict item for a path the record does not know (the merge was started outside the app). */
async function classify(dir: string, relPath: string): Promise<StoredItem> {
  const stages = await stagesOf(dir, relPath)
  const label = await labelFor(relPath, stageReader(dir))
  if (stages.has(3) && !stages.has(2)) return { kind: 'deleted_local', label }
  if (stages.has(2) && !stages.has(3)) return { kind: 'deleted_remote', label }
  return { kind: 'file', label }
}

async function conflictItems(dir: string, conflicted: string[]): Promise<Map<string, StoredItem>> {
  const record = await readRecord(dir)
  const items = new Map<string, StoredItem>()
  for (const p of conflicted) items.set(p, record?.items[p] ?? (await classify(dir, p)))
  return items
}

export async function readSyncState(dir: string): Promise<SyncState> {
  if (!(await isOwnRepo(dir))) return { ...NOT_LINKED, changes: [], conflicts: [] }
  const status = await readStatus(dir)
  const [identity, counts, changes, items] = await Promise.all([
    readIdentity(dir),
    aheadBehind(dir, status.branch),
    describeChanges(dir, status.changes, headReader(dir)),
    status.merging ? conflictItems(dir, status.conflicted) : new Map<string, StoredItem>(),
  ])
  return {
    linked: status.remoteUrl !== null,
    branch: status.branch,
    remoteUrl: status.remoteUrl,
    ...counts,
    changes,
    merging: status.merging,
    conflicts: [...items].map(([id, stored]) => toItem(id, stored)),
    identity,
  }
}

// --- commit ----------------------------------------------------------------------------------------------------

/** Stages everything but `.local/` and commits; resolves false (committing nothing) when nothing changed. */
async function commitChanges(dir: string, message: unknown): Promise<boolean> {
  const text = typeof message === 'string' ? message.trim() : ''
  if (text === '') throw new Error('Enter a commit message')
  // With `.local/` ignored, `add --all` leaves it out; anything under it that is staged anyway (tracked earlier, or
  // re-included by a negated pattern) is refused below.
  await ensureGitignore(dir)
  await git(dir, ['add', '--all'])
  const staged = nulSplit(await git(dir, ['diff', '--cached', '--name-only', '-z']))
  if (staged.some(isLocalPath)) {
    throw new GitError('failed', 'Refusing to commit .local/: it holds secrets. Unstage it first', '')
  }
  if (staged.length === 0) return false
  await requireIdentity(dir)
  await git(dir, ['commit', '--quiet', '-F', '-'], `${text}\n`)
  return true
}

export async function commit(dir: string, message: unknown): Promise<void> {
  await requireRepo(dir)
  await requireNotMerging(dir)
  await commitChanges(dir, message)
}

export async function setIdentity(dir: string, name: unknown, email: unknown): Promise<void> {
  const n = typeof name === 'string' ? name.trim() : ''
  const e = typeof email === 'string' ? email.trim() : ''
  if (n === '' || e === '' || /[\0\r\n]/.test(n + e)) throw new Error('Enter your name and email')
  await requireRepo(dir)
  await git(dir, ['config', '--local', 'user.name', n])
  await git(dir, ['config', '--local', 'user.email', e])
}

// --- merging ---------------------------------------------------------------------------------------------------

async function fetchOrigin(dir: string): Promise<void> {
  await git(dir, ['fetch', '--quiet', '--prune', 'origin'])
}

/** Rejects when uncommitted changes touch files that `ref` changed since the common ancestor. */
async function refuseTouching(dir: string, ref: string): Promise<void> {
  const { changes } = await readStatus(dir)
  if (changes.length === 0) return
  const base = (await outputOrNull(dir, ['merge-base', 'HEAD', ref]))?.trim()
  if (!base) return
  const incoming = new Set(nulSplit(await git(dir, ['diff', '--name-only', '-z', base, ref])))
  const touched = changes.filter((c) => incoming.has(c.path) || (c.from !== undefined && incoming.has(c.from)))
  if (touched.length === 0) return
  const labels = (await describeChanges(dir, touched, headReader(dir))).map((c) => c.label)
  throw new GitError('failed', `Your changes to ${labels.join(', ')} would be overwritten. Commit them first`, '')
}

async function writeWorkspaceFile(dir: string, relPath: string, text: string): Promise<void> {
  const file = path.join(dir, relPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text, 'utf8')
}

/** Settles one conflicted path with the field-level merge; returns what is left for the user, or null. */
async function settle(dir: string, relPath: string): Promise<StoredItem | null> {
  const stages = await stagesOf(dir, relPath)
  const label = await labelFor(relPath, stageReader(dir))
  if (stages.has(3) && !stages.has(2)) return { kind: 'deleted_local', label }
  if (stages.has(2) && !stages.has(3)) return { kind: 'deleted_remote', label }
  const kind = fileKind(relPath)
  if (!stages.has(2) || kind === 'other') return { kind: 'file', label }
  const stage = (n: number) => (stages.has(n) ? outputOrNull(dir, ['show', `:${n}:${relPath}`]) : null)
  const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)])
  const outcome = mergeJson(kind, base, ours, theirs)
  if (outcome.kind === 'merged') {
    await writeWorkspaceFile(dir, relPath, outcome.text)
    await gitPaths(dir, ['add'], [relPath])
    return null
  }
  if (outcome.kind === 'conflicts') {
    return { kind: 'fields', label, fileKind: kind, partial: outcome.partial, conflicts: outcome.conflicts }
  }
  return { kind: 'file', label }
}

/** Commits the merge in progress with git's default message and forgets its record. */
async function commitMerge(dir: string): Promise<void> {
  await git(dir, ['commit', '--quiet', '--no-edit'])
  await deleteRecord(dir)
}

/**
 * Merges `ref` into HEAD: a fast-forward when HEAD has nothing of its own, else `merge --no-ff --no-commit` with the
 * stopped paths settled field by field. Commits when nothing is left; else records the conflicts.
 */
async function mergeIncoming(
  dir: string,
  ref: string,
  operation: Operation,
  unrelated = false,
): Promise<{ pulled: number; conflicts: boolean }> {
  if (!(await hasHead(dir))) {
    const pulled = await count(dir, [ref])
    await git(dir, ['merge', '--quiet', '--ff-only', ref])
    return { pulled, conflicts: false }
  }
  const pulled = await count(dir, [`HEAD..${ref}`])
  if (pulled === 0) return { pulled, conflicts: false }
  if (await succeeds(dir, ['merge-base', '--is-ancestor', 'HEAD', ref])) {
    await git(dir, ['merge', '--quiet', '--ff-only', ref])
    return { pulled, conflicts: false }
  }
  await requireIdentity(dir)
  await deleteRecord(dir)
  const args = ['merge', '--quiet', '--no-ff', '--no-commit', ...(unrelated ? ['--allow-unrelated-histories'] : [])]
  try {
    await git(dir, [...args, ref])
  } catch (e) {
    // A merge that stopped on conflicts leaves MERGE_HEAD; anything else (e.g. local changes in the way) did not
    // start one.
    if (!(await isMerging(dir))) throw e
  }
  const { conflicted } = await readStatus(dir)
  const items: Record<string, StoredItem> = {}
  for (const p of conflicted) {
    const item = await settle(dir, p)
    if (item) items[p] = item
  }
  if (Object.keys(items).length === 0) {
    await commitMerge(dir)
    return { pulled, conflicts: false }
  }
  const record: MergeRecord = { version: 1, operation, pulled, items }
  await writeJsonAtomic(await recordPath(dir), record)
  return { pulled, conflicts: true }
}

/** Pushes HEAD to origin's branch of the same name, setting the upstream; resolves how many commits went. */
async function pushCommits(dir: string): Promise<number> {
  await requireBranch(dir)
  if (!(await hasHead(dir))) return 0
  const n = await count(dir, ['HEAD', '--not', '--remotes=origin'])
  if (n === 0) return 0
  await git(dir, ['push', '--quiet', '--set-upstream', 'origin', 'HEAD'])
  return n
}

const outcomeOf = (pulled: number, pushed: number): SyncOutcome =>
  pulled === 0 && pushed === 0 ? { kind: 'up_to_date' } : { kind: 'done', pulled, pushed }

/** Fetches and merges origin's branch; null when the merge stopped with conflicts. */
async function pullInto(dir: string, operation: Operation): Promise<number | null> {
  const branch = await requireBranch(dir)
  await fetchOrigin(dir)
  const ref = remoteRef(branch)
  if (!(await refExists(dir, ref))) return 0
  await refuseTouching(dir, ref)
  const { pulled, conflicts } = await mergeIncoming(dir, ref, operation)
  return conflicts ? null : pulled
}

// --- operations ------------------------------------------------------------------------------------------------

export async function sync(dir: string, message: unknown): Promise<SyncOutcome> {
  await requireLinked(dir)
  await requireNotMerging(dir)
  if (message !== null) await commitChanges(dir, message)
  const pulled = await pullInto(dir, 'sync')
  if (pulled === null) return { kind: 'conflicts', state: await readSyncState(dir) }
  return outcomeOf(pulled, await pushCommits(dir))
}

export async function pull(dir: string): Promise<SyncOutcome> {
  await requireLinked(dir)
  await requireNotMerging(dir)
  const pulled = await pullInto(dir, 'pull')
  if (pulled === null) return { kind: 'conflicts', state: await readSyncState(dir) }
  return outcomeOf(pulled, 0)
}

export async function push(dir: string): Promise<SyncOutcome> {
  await requireLinked(dir)
  await requireNotMerging(dir)
  return outcomeOf(0, await pushCommits(dir))
}

/** The default branch origin advertises (`ls-remote --symref origin HEAD`), or null. */
async function remoteDefaultBranch(dir: string): Promise<string | null> {
  const out = await outputOrNull(dir, ['ls-remote', '--symref', 'origin', 'HEAD'])
  const match = out === null ? null : /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)
  return match ? match[1] : null
}

export async function link(dir: string, url: unknown): Promise<SyncState> {
  const remoteUrl = validUrl(url)
  if (await isOwnRepo(dir)) await requireNotMerging(dir)
  else await git(dir, ['init', '--quiet'])
  const hasOrigin = (await originUrl(dir)) !== null
  await git(dir, ['remote', hasOrigin ? 'set-url' : 'add', 'origin', remoteUrl])
  await fetchOrigin(dir)

  let branch = await requireBranch(dir)
  const born = await hasHead(dir)
  if (!(await refExists(dir, remoteRef(branch)))) {
    // A workspace with no commits takes the remote's default branch name; one with commits keeps its branch, and
    // the first push creates it on the remote.
    const fallback = born ? null : await remoteDefaultBranch(dir)
    if (fallback === null || !(await refExists(dir, remoteRef(fallback)))) return readSyncState(dir)
    await git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${fallback}`])
    branch = fallback
  }
  const ref = remoteRef(branch)
  if (!born) {
    // The workspace's own files become a commit first, so the merge can keep them next to the remote's.
    await requireIdentity(dir)
    await commitChanges(dir, INITIAL_MESSAGE)
  }
  const related = (await hasHead(dir)) ? await succeeds(dir, ['merge-base', 'HEAD', ref]) : true
  await mergeIncoming(dir, ref, 'link', !related)
  return readSyncState(dir)
}

export async function unlink(dir: string): Promise<SyncState> {
  await requireRepo(dir)
  await requireNotMerging(dir)
  if ((await originUrl(dir)) !== null) await git(dir, ['remote', 'remove', 'origin'])
  return readSyncState(dir)
}

/** Fetches origin and reads the state (for the periodic refresh of `behind`). */
export async function fetch(dir: string): Promise<SyncState> {
  await requireLinked(dir)
  await fetchOrigin(dir)
  return readSyncState(dir)
}

/** The absolute path of conflict item `id`; rejects for anything that is not a current conflict. */
async function conflictItem(dir: string, id: unknown): Promise<{ id: string; stored: StoredItem }> {
  await requireRepo(dir)
  if (typeof id !== 'string') throw new Error('invalid_argument')
  const { merging, conflicted } = await readStatus(dir)
  if (!merging || !conflicted.includes(id)) throw new GitError('failed', `No conflict for ${id}`, '')
  const stored = (await conflictItems(dir, [id])).get(id) as StoredItem
  return { id, stored }
}

export async function conflictPath(dir: string, id: unknown): Promise<string> {
  const item = await conflictItem(dir, id)
  return path.join(dir, item.id)
}

function wholeChoice(choice: SyncChoice): 'ours' | 'theirs' {
  if (choice === 'ours' || choice === 'theirs') return choice
  throw new Error('Choose a whole file: ours or theirs')
}

/** Git's conflict markers at the start of a line: `<<<<<<< ours` and `>>>>>>> theirs` (`=======` alone is common text). */
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/m

/** Stages the working-tree file of a `file` item as the user edited it, once it has no markers (and parses). */
async function useEdited(dir: string, relPath: string, label: string): Promise<void> {
  let text: string
  try {
    text = await fs.readFile(path.join(dir, relPath), 'utf8')
  } catch {
    throw new GitError('failed', notResolvedMessage(label), '')
  }
  let valid = !CONFLICT_MARKER.test(text)
  if (valid && fileKind(relPath) !== 'other') {
    try {
      JSON.parse(text)
    } catch {
      valid = false
    }
  }
  if (!valid) throw new GitError('failed', notResolvedMessage(label), '')
  await gitPaths(dir, ['add'], [relPath])
}

export async function resolve(dir: string, id: unknown, choice: SyncChoice): Promise<SyncState> {
  const item = await conflictItem(dir, id)
  const p = item.id
  const stored = item.stored
  if (choice === 'edited') {
    if (stored.kind !== 'file') throw new Error('Use the edited file only for a file conflict')
    await useEdited(dir, p, stored.label)
    return readSyncState(dir)
  }
  if (stored.kind === 'fields') {
    let choose: (c: FieldConflict) => 'ours' | 'theirs'
    if (choice === 'ours' || choice === 'theirs') {
      choose = () => choice
    } else {
      const map = typeof choice === 'object' && choice !== null ? choice.fields : undefined
      const side = (c: FieldConflict) => (map && Object.hasOwn(map, c.path) ? map[c.path] : undefined)
      if (!stored.conflicts.every((c) => side(c) === 'ours' || side(c) === 'theirs')) {
        throw new Error('Choose a side for every field')
      }
      choose = (c) => side(c) as 'ours' | 'theirs'
    }
    await writeWorkspaceFile(dir, p, applyChoices(stored.fileKind, stored.partial, stored.conflicts, choose))
    await gitPaths(dir, ['add'], [p])
    return readSyncState(dir)
  }
  const side = wholeChoice(choice)
  const keep =
    stored.kind === 'file' ||
    (stored.kind === 'deleted_remote' && side === 'ours') ||
    (stored.kind === 'deleted_local' && side === 'theirs')
  if (keep) {
    await gitPaths(dir, ['checkout', side === 'ours' ? '--ours' : '--theirs'], [p])
    await gitPaths(dir, ['add'], [p])
  } else {
    await gitPaths(dir, ['rm', '--quiet'], [p])
  }
  return readSyncState(dir)
}

export async function finishMerge(dir: string): Promise<SyncOutcome> {
  await requireRepo(dir)
  if (!(await isMerging(dir))) throw new GitError('failed', 'There is no merge to finish', '')
  if ((await git(dir, ['ls-files', '--unmerged'])).trim() !== '') {
    throw new GitError('conflict', 'Resolve every conflict first', '')
  }
  await requireIdentity(dir)
  const record = await readRecord(dir)
  await commitMerge(dir)
  const pulled = record?.pulled ?? 0
  if (record?.operation !== 'sync') return { kind: 'done', pulled, pushed: 0 }
  return { kind: 'done', pulled, pushed: await pushCommits(dir) }
}

export async function abortMerge(dir: string): Promise<SyncState> {
  await requireRepo(dir)
  if (await isMerging(dir)) await git(dir, ['merge', '--abort'])
  await deleteRecord(dir)
  return readSyncState(dir)
}
