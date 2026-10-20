import { create } from 'zustand'
import type {
  CollectionTree,
  Environment,
  LoadError,
  RequestItem,
  SendResult,
  TreeNode,
  WorkspaceInfo,
} from '../../../shared/types'
import {
  GLOBALS_ID,
  GLOBALS_NAME,
  draftProblem,
  fingerprint,
  isDraftDirty,
  toDraft,
  toEnvironment,
  type Draft,
} from '../lib/environments'

/** A tab: the path of a request, or `env:<id>` (see `environmentTabId`) for an environment editor. */
export interface OpenTab {
  path: string
}

const ENV_TAB = 'env:'

/** The tab id of the editor of environment `id`; request paths never start with `env:`. */
export function environmentTabId(id: string): string {
  return ENV_TAB + id
}

/** The environment id of an environment tab, or null for a request tab. */
export function environmentIdOf(tab: string): string | null {
  return tab.startsWith(ENV_TAB) ? tab.slice(ENV_TAB.length) : null
}

/**
 * The edited copy of an environment, kept while its tab is open (and after closing it if that save failed, so
 * reopening recovers it). `baseline` is the fingerprint of what the draft started from or was last saved as.
 */
export interface EnvironmentDraft {
  draft: Draft
  baseline: string
}

/**
 * Autosave status of a dirty draft; a path without an entry is saved. `conflict`: the file changed on disk since the
 * draft's baseline was read; nothing is saved until the user picks Overwrite or Reload from disk.
 */
export interface SaveStatus {
  state: 'saving' | 'failed' | 'conflict'
  error?: string
}

export type ResponseTab = 'body' | 'headers' | 'cookies'
export type BodyMode = 'pretty' | 'raw' | 'preview'

/** What the response viewer of a request shows; remembered for the session. */
export interface ResponseView {
  tab: ResponseTab
  mode: BodyMode
}

export const DEFAULT_RESPONSE_VIEW: ResponseView = { tab: 'body', mode: 'pretty' }

export interface ResponseEntry {
  state: 'idle' | 'sending' | 'done'
  result?: SendResult
}

/** Autosave runs this long after the last change. */
export const AUTOSAVE_DELAY_MS = 500

export interface AppState {
  workspace: WorkspaceInfo | null
  collections: CollectionTree[]
  loadErrors: LoadError[]
  openTabs: OpenTab[]
  activePath: string | null
  environments: Environment[]
  activeEnvironmentId: string | null
  /** Environment files that could not be read; the healthy ones are in `environments`. */
  environmentErrors: LoadError[]
  /** Non-blocking note shown in the top bar, e.g. when the active environment vanished. */
  environmentNotice: string | null
  error: string | null
  /** Expanded collections and folders by path; kept here so the tree survives re-renders and refreshes. */
  expanded: Record<string, true>
  /** Editable copies of the open requests by path; the tree's `request` is the saved baseline. */
  drafts: Record<string, RequestItem>
  /** Draft paths with changes that are not on disk yet (waiting, saving, or failed). */
  saves: Record<string, SaveStatus>
  /** The latest send per open request. */
  responses: Record<string, ResponseEntry>
  /** The selected response tab and body mode per request; missing entries mean the defaults. */
  responseViews: Record<string, ResponseView>
  /** Environment drafts by environment id; see `EnvironmentDraft`. */
  environmentDrafts: Record<string, EnvironmentDraft>
}

export interface AppActions {
  openWorkspace(dir: string): Promise<void>
  createWorkspace(dir: string, name: string): Promise<void>
  refresh(): Promise<void>
  createCollection(name: string): Promise<void>
  createFolder(parentPath: string, name: string): Promise<void>
  createRequest(parentPath: string, name: string): Promise<void>
  rename(path: string, name: string): Promise<void>
  remove(path: string): Promise<void>
  move(path: string, parentPath: string, index: number): Promise<void>
  openRequest(path: string): void
  /**
   * Opens (or activates) the editor tab of environment `id`. `fresh` is the draft of an environment that is not saved
   * yet (new or duplicated); without it the stored environment (or the empty globals set) is the starting point.
   */
  openEnvironment(id: string, fresh?: Draft): void
  /** Replaces the draft of an open environment tab; nothing is saved until Save, closing the tab, or `flushAll`. */
  editEnvironmentDraft(id: string, update: (entry: EnvironmentDraft) => EnvironmentDraft): void
  /**
   * Closes a request or environment tab. A changed environment draft is saved, like a request's; one that cannot be
   * saved (invalid), or any with `discard`, is dropped.
   */
  closeTab(path: string, options?: { discard?: boolean }): void
  /** Replaces the draft of an open request and schedules an autosave. */
  editDraft(path: string, update: (draft: RequestItem) => RequestItem): void
  /** Writes the draft now, also retrying a failed save. */
  saveNow(path: string): Promise<void>
  /** Starts any debounced save of `path` immediately (tab switch, send). */
  flushSave(path: string): void
  /** Starts every debounced save immediately (window unload). */
  flushAllSaves(): void
  /**
   * Writes every unsaved draft, including closed tabs' and failed ones, after any rename, move or delete in progress;
   * resolves when all of it is on disk (or failed). Used before the app quits or the window closes.
   */
  flushAll(): Promise<void>
  /**
   * "Switch workspace": writes all drafts (as `flushAll`), then closes the workspace and returns to the gate. Resolves
   * `unsaved` (and stays) if some changes could not be written, unless `discardUnsaved` is set.
   */
  leaveWorkspace(options?: { discardUnsaved?: boolean }): Promise<'left' | 'unsaved'>
  /** Paths of drafts (open or closed) with changes that are not on disk, e.g. after a failed save or a conflict. */
  unsavedPaths(): string[]
  /** Resolves a `conflict`: writes the draft over the file on disk. */
  overwriteOnDisk(path: string): Promise<void>
  /** Resolves a `conflict`: discards the draft and adopts the file on disk. */
  reloadFromDisk(path: string): Promise<void>
  send(path: string): Promise<void>
  /** Cancels the send in flight for `path`, if any; sends of other tabs keep running. */
  cancelSend(path: string): Promise<void>
  setResponseView(path: string, patch: Partial<ResponseView>): void
  setActiveEnvironment(id: string | null): void
  /**
   * Writes `env`, then reloads the environments. Resolves `false` if the workspace changed meanwhile (nothing was
   * applied); rejects with the main-process error, which the caller shows next to its form.
   */
  saveEnvironment(env: Environment): Promise<boolean>
  /** Deletes an environment; the selection is reset if it was the active one. Same result contract as `saveEnvironment`. */
  removeEnvironment(id: string): Promise<boolean>
  dismissEnvironmentNotice(): void
  setExpanded(path: string, expanded: boolean): void
  dismissError(): void
}

export function initialState(): AppState {
  return {
    workspace: null,
    collections: [],
    loadErrors: [],
    openTabs: [],
    activePath: null,
    environments: [],
    activeEnvironmentId: null,
    environmentErrors: [],
    environmentNotice: null,
    error: null,
    expanded: {},
    drafts: {},
    saves: {},
    responses: {},
    responseViews: {},
    environmentDrafts: {},
  }
}

/** Main-process errors that mean the workspace folder is gone: the UI returns to the workspace gate. */
const GATE_ERRORS = ['workspace_unavailable', 'no_workspace_open']

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Maps `path` after `from` was renamed or moved to `to`, including everything below it. */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : path
}

function sameRequest(a: RequestItem, b: RequestItem): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function requestsByPath(nodes: TreeNode[], into: Map<string, RequestItem>): Map<string, RequestItem> {
  for (const node of nodes) {
    if (node.kind === 'request') into.set(node.path, node.request)
    else requestsByPath(node.children, into)
  }
  return into
}

function revisionsByPath(nodes: TreeNode[], into: Map<string, string>): Map<string, string> {
  for (const node of nodes) {
    if (node.kind === 'request') into.set(node.path, node.revision)
    else revisionsByPath(node.children, into)
  }
  return into
}

function revisionFromTree(collections: CollectionTree[], path: string): string | undefined {
  for (const c of collections) {
    const found = revisionsByPath(c.children, new Map()).get(path)
    if (found !== undefined) return found
  }
  return undefined
}

const CHANGED_ON_DISK = 'changed_on_disk'

/** Re-keys a record whose keys are paths after `from` was renamed or moved to `to`. */
function remapKeys<T>(record: Record<string, T>, from: string, to: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([p, v]) => [remapPath(p, from, to), v]))
}

function without<T>(record: Record<string, T>, paths: string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([p]) => !paths.includes(p)))
}

/** Autosave bookkeeping of one open request. `path` follows renames; `version` counts edits. */
interface SaveEntry {
  path: string
  version: number
  savedVersion: number
  timer: ReturnType<typeof setTimeout> | null
  /** The tail of this path's save queue (null when idle); never rejects. */
  running: Promise<void> | null
  /** The latest draft, kept here so a save still has it after the tab was closed. */
  draft: RequestItem
  /** A save came due while a rename/move/delete of this path was running. */
  deferred: boolean
  /** The error of the last save of a closed tab; the entry (and its draft) is kept so reopening can recover it. */
  failed: string | null
  dropped: 'closed' | 'removed' | null
  /** The last save found the file changed on disk; saving waits for Overwrite or Reload from disk. */
  conflict: boolean
  /** The next save writes without a revision check (Overwrite). */
  overwrite: boolean
}

/** One in-flight send; `id` names it to the main process, `path` follows renames, `dead` marks a closed tab. */
interface SendTicket {
  id: string
  path: string
  dead: boolean
}

function requestFromTree(collections: CollectionTree[], path: string): RequestItem | null {
  for (const c of collections) {
    const found = requestsByPath(c.children, new Map()).get(path)
    if (found) return found
  }
  return null
}

function isWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

function requestPaths(nodes: TreeNode[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.kind === 'request') into.add(node.path)
    else requestPaths(node.children, into)
  }
  return into
}

/** The tab to activate once `path` is closed: the one that took its place, else the previous one. */
function neighbour(tabs: OpenTab[], index: number): string | null {
  return (tabs[index] ?? tabs[index - 1])?.path ?? null
}

export const useApp = create<AppState & AppActions>()((set, get) => {
  /** Incremented whenever the workspace is replaced or lost; follow-up work from an older epoch is discarded. */
  let epoch = 0
  let openSeq = 0
  let refreshSeq = 0
  const entries = new Map<string, SaveEntry>()
  /** Entries of closed tabs whose save is still pending or running; kept until it settles. */
  const pending = new Map<string, SaveEntry>()
  const tickets = new Set<SendTicket>()
  /** Paths whose files a rename, move or delete is changing; saves below them wait until it is done. */
  let locks: string[] = []
  /**
   * The revision of the file each draft (open or still saving after its tab closed) is based on; sent with every save
   * so a file changed on disk meanwhile is not overwritten. Updated from the tree while the draft is clean and by each
   * successful save.
   */
  const revisions = new Map<string, string | undefined>()
  /** Paths renamed or moved by the app itself: the next refresh takes their revision even if the draft is dirty. */
  const adoptRevision = new Set<string>()
  /** Renames, moves and deletes in progress; `flushAll` waits for them. */
  const lockedOps = new Set<Promise<void>>()

  function resetEditing(): void {
    for (const e of entries.values()) if (e.timer) clearTimeout(e.timer)
    entries.clear()
    for (const e of pending.values()) if (e.timer) clearTimeout(e.timer)
    pending.clear()
    tickets.clear()
    locks = []
    revisions.clear()
    adoptRevision.clear()
  }

  function isLocked(path: string): boolean {
    return locks.some((l) => isWithin(path, l))
  }

  function entryFor(path: string, draft: RequestItem): SaveEntry {
    let e = entries.get(path)
    if (!e) {
      e = {
        path,
        version: 0,
        savedVersion: 0,
        timer: null,
        running: null,
        draft,
        deferred: false,
        failed: null,
        dropped: null,
        conflict: false,
        overwrite: false,
      }
      entries.set(path, e)
    }
    return e
  }

  function setSave(path: string, status: SaveStatus | null): void {
    set((s) => {
      if (status === null) return path in s.saves ? { saves: without(s.saves, [path]) } : s
      return { saves: { ...s.saves, [path]: status } }
    })
  }

  /** `dropped` changes while a save awaits the disk, which the compiler's narrowing cannot see. */
  function droppedAs(e: SaveEntry): SaveEntry['dropped'] {
    return e.dropped
  }

  /** Writes the current draft of `e`, after any save already running for it. */
  function runSave(e: SaveEntry): Promise<void> {
    if (e.timer) clearTimeout(e.timer)
    e.timer = null
    const task = e.running ? e.running.then(() => doSave(e)) : doSave(e)
    const tracked: Promise<void> = task.finally(() => {
      if (e.running === tracked) {
        e.running = null
        // A closed tab's entry is forgotten once nothing is left to save for it.
        if (e.dropped === 'closed' && !e.deferred && !e.failed && pending.get(e.path) === e) pending.delete(e.path)
      }
    })
    e.running = tracked
    return tracked
  }

  function schedule(e: SaveEntry): void {
    if (e.timer) clearTimeout(e.timer)
    e.timer = setTimeout(() => void runSave(e), AUTOSAVE_DELAY_MS)
  }

  async function doSave(e: SaveEntry): Promise<void> {
    if (e.dropped === 'removed') return
    if (isLocked(e.path)) {
      e.deferred = true
      return
    }
    // Waits for the user's decision (Overwrite or Reload from disk); the status stays `conflict`.
    if (e.conflict) return
    if (e.version === e.savedVersion) {
      // Nothing left to write: a stale failed/saving status of this path must not survive.
      if (e.dropped === null) setSave(e.path, null)
      return
    }
    const draft = e.draft
    const version = e.version
    const started = epoch
    const path = e.path
    const overwrite = e.overwrite
    e.overwrite = false
    if (e.dropped === null) setSave(path, { state: 'saving' })
    let revision: string | undefined
    try {
      const result = await window.astral.collections.saveRequest(
        path,
        draft,
        overwrite ? undefined : revisions.get(path),
      )
      revision = typeof result === 'string' ? result : undefined
    } catch (err) {
      if (epoch !== started || droppedAs(e) === 'removed') return
      if (messageOf(err).startsWith(CHANGED_ON_DISK)) {
        e.conflict = true
        if (droppedAs(e) === 'closed') {
          e.failed = 'it was changed on disk'
          set({ error: `Could not save ${e.path}: ${e.failed}` })
        } else {
          setSave(e.path, { state: 'conflict' })
        }
        return
      }
      // An Overwrite that failed for another reason is still an Overwrite when it is retried.
      if (overwrite) e.overwrite = true
      if (droppedAs(e) === 'closed') {
        if (isGateError(err)) {
          fail(err)
        } else {
          e.failed = messageOf(err)
          set({ error: `Could not save ${e.path}: ${e.failed}` })
        }
      } else if (isGateError(err)) {
        fail(err)
      } else {
        setSave(e.path, { state: 'failed', error: messageOf(err) })
      }
      return
    }
    if (epoch !== started || droppedAs(e) === 'removed') return
    revisions.set(e.path, revision)
    if (droppedAs(e) === 'closed') {
      // Nobody watches this draft any more, but the tree must show what is on disk when the request is reopened.
      e.savedVersion = version
      if (e.version === version) e.failed = null
      // The entry stays until the refresh has applied, so a reopen in between still starts from its draft.
      await get().refresh()
      if (epoch !== started) return
      if (droppedAs(e) === null && e.version === e.savedVersion) setSave(e.path, null)
      return
    }
    e.savedVersion = version
    if (e.version === version) {
      setSave(e.path, null)
      // The tree's baseline is the file on disk; reload it so a later refresh cannot look like an external change.
      void get().refresh()
    }
  }

  /** Forgets autosave and send state of requests that are gone (closed, deleted or vanished from disk). */
  function dropEditing(paths: string[], reason: 'closed' | 'removed'): void {
    for (const p of paths) {
      const e = entries.get(p)
      if (e) {
        if (e.timer) clearTimeout(e.timer)
        e.timer = null
        e.dropped = reason
        entries.delete(p)
        if (reason === 'closed' && (e.running || e.deferred)) pending.set(p, e)
      }
      const waiting = pending.get(p)
      if (waiting && reason === 'removed') {
        waiting.dropped = 'removed'
        pending.delete(p)
      }
      if (reason === 'removed') revisions.delete(p)
    }
    for (const t of tickets) if (paths.includes(t.path)) t.dead = true
    set((s) => ({
      drafts: without(s.drafts, paths),
      saves: without(s.saves, paths),
      responses: without(s.responses, paths),
      responseViews: without(s.responseViews, paths),
    }))
  }

  function remapEditing(from: string, to: string): void {
    for (const map of [entries, pending]) {
      for (const [p, e] of [...map]) {
        if (!isWithin(p, from)) continue
        map.delete(p)
        e.path = remapPath(p, from, to)
        map.set(e.path, e)
      }
    }
    for (const t of tickets) t.path = remapPath(t.path, from, to)
    for (const [p, revision] of [...revisions]) {
      if (!isWithin(p, from)) continue
      revisions.delete(p)
      revisions.set(remapPath(p, from, to), revision)
    }
    // A rename rewrites the request file (its name), so the old revision is stale; the refresh brings the new one.
    for (const p of revisions.keys()) if (isWithin(p, to)) adoptRevision.add(p)
    set((s) => ({
      drafts: remapKeys(s.drafts, from, to),
      saves: remapKeys(s.saves, from, to),
      responses: remapKeys(s.responses, from, to),
      responseViews: remapKeys(s.responseViews, from, to),
    }))
  }

  /**
   * Runs `fn` (which renames, moves or deletes `path`) while no save may write below `path`: running saves finish
   * first, saves that come due meanwhile resume afterwards, under the new path if there is one. The tree is reloaded
   * after `fn`, so `fn` itself should not reload it.
   */
  function locked(path: string, fn: () => Promise<void>): Promise<void> {
    const op = runLocked(path, fn)
    lockedOps.add(op)
    const forget = (): void => {
      lockedOps.delete(op)
    }
    op.then(forget, forget)
    return op
  }

  async function runLocked(path: string, fn: () => Promise<void>): Promise<void> {
    const affected = [...entries.values(), ...pending.values()].filter((e) => isWithin(e.path, path))
    for (const e of affected) if (e.timer) e.deferred = true
    const started = epoch
    locks.push(path)
    // A refresh already in flight may read the disk mid-change and then apply after it; its result is discarded.
    refreshSeq++
    try {
      await Promise.all(affected.map((e) => e.running))
      await fn()
    } finally {
      // After a workspace change the locks (and everything else) were reset already.
      if (epoch === started) {
        locks.splice(locks.indexOf(path), 1)
        // Reloaded once the change is done (a refresh under the lock keeps what it may have read mid-change), and
        // before deferred saves resume, so they write with the revisions now on disk.
        await get().refresh()
        for (const e of [...entries.values(), ...pending.values()]) {
          if (e.deferred && !isLocked(e.path)) {
            e.deferred = false
            void runSave(e)
          }
        }
      }
    }
  }

  function isGateError(e: unknown): boolean {
    const message = messageOf(e)
    return GATE_ERRORS.some((code) => message.startsWith(code))
  }

  function flush(path: string | null): void {
    if (path === null) return
    const e = entries.get(path)
    if (e?.timer) void runSave(e)
  }

  function fail(e: unknown): void {
    const message = messageOf(e)
    if (isGateError(e)) {
      epoch++
      resetEditing()
      set({ error: message, workspace: null })
    } else {
      set({ error: message })
    }
  }

  /**
   * Runs an API call, turns a rejection into `error`, applies `apply` on success, then reloads the tree (it may have
   * changed on disk). Nothing is touched if the workspace changed while the call was in flight.
   */
  async function mutate<T>(call: () => Promise<T>, apply?: (result: T) => void, reload = true): Promise<void> {
    const started = epoch
    try {
      const result = await call()
      if (epoch !== started) return
      apply?.(result)
    } catch (e) {
      if (epoch !== started) return
      fail(e)
    }
    if (reload) await get().refresh()
  }

  /** Runs an environment write and reloads; unlike `mutate` a rejection goes to the caller, except gate errors. */
  async function environmentCall(call: () => Promise<void>, apply?: () => void): Promise<boolean> {
    const started = epoch
    try {
      await call()
    } catch (e) {
      if (epoch !== started) return false
      if (isGateError(e)) {
        fail(e)
        return false
      }
      throw e
    }
    if (epoch !== started) return false
    apply?.()
    await get().refresh()
    return epoch === started
  }

  /** The stored environment, or the empty globals set that exists before its first save. */
  function storedEnvironment(id: string): Environment | undefined {
    const found = get().environments.find((e) => e.id === id)
    if (found || id !== GLOBALS_ID) return found
    return { id: GLOBALS_ID, name: GLOBALS_NAME, variables: [] }
  }

  /**
   * Writes an environment draft (of an open or a closed tab). On success the draft of an open tab becomes clean and
   * that of a closed tab is forgotten; on failure it is kept, so reopening the tab recovers it.
   */
  async function writeEnvironmentDraft(id: string, entry: EnvironmentDraft): Promise<void> {
    const env = toEnvironment(entry.draft)
    try {
      if (!(await get().saveEnvironment(env))) return
    } catch (e) {
      set({ error: `Could not save the environment "${env.name}": ${messageOf(e)}` })
      return
    }
    set((s) => {
      const current = s.environmentDrafts[id]
      if (!current) return s
      const open = s.openTabs.some((t) => t.path === environmentTabId(id))
      if (!open && current === entry) return { environmentDrafts: without(s.environmentDrafts, [id]) }
      if (!open) return s
      return {
        environmentDrafts: {
          ...s.environmentDrafts,
          [id]: { draft: { ...current.draft, name: env.name, isNew: false }, baseline: fingerprint(env) },
        },
      }
    })
  }

  /** Drafts that have changes and can be written as they are. */
  function savableEnvironmentDrafts(): [string, EnvironmentDraft][] {
    const { environmentDrafts, environments } = get()
    return Object.entries(environmentDrafts).filter(
      ([, entry]) => isDraftDirty(entry) && draftProblem(entry.draft, environments) === null,
    )
  }

  function remapTabs(from: string, to: string): void {
    remapEditing(from, to)
    set((s) => ({
      openTabs: s.openTabs.map((t) => ({ path: remapPath(t.path, from, to) })),
      activePath: s.activePath === null ? null : remapPath(s.activePath, from, to),
      expanded: Object.fromEntries(Object.keys(s.expanded).map((p) => [remapPath(p, from, to), true as const])),
    }))
  }

  async function enter(open: () => Promise<WorkspaceInfo>): Promise<void> {
    const mine = ++openSeq
    try {
      const workspace = await open()
      if (mine !== openSeq) return
      epoch++
      resetEditing()
      set({ ...initialState(), workspace })
    } catch (e) {
      if (mine === openSeq) fail(e)
      return
    }
    await get().refresh()
    if (mine !== openSeq) return
    set((s) => ({
      expanded: { ...s.expanded, ...Object.fromEntries(s.collections.map((c) => [c.path, true as const])) },
    }))
  }

  return {
    ...initialState(),

    openWorkspace: (dir) => enter(() => window.astral.workspace.open(dir)),
    createWorkspace: (dir, name) => enter(() => window.astral.workspace.create(dir, name)),

    async refresh() {
      if (!get().workspace) return
      const started = epoch
      const mine = ++refreshSeq
      const [collections, environments] = await Promise.allSettled([
        window.astral.collections.list(),
        window.astral.environments.list(),
      ])
      // Only the latest refresh of the current workspace may apply its result.
      if (mine !== refreshSeq || epoch !== started) return
      if (collections.status === 'fulfilled') {
        const saved = new Map<string, RequestItem>()
        const onDisk = new Map<string, string>()
        for (const c of collections.value.collections) {
          requestsByPath(c.children, saved)
          revisionsByPath(c.children, onDisk)
        }
        // A clean draft follows the disk, so its revision does too; a dirty one keeps the revision its edits are based on.
        const unsaved = get().saves
        for (const { path } of get().openTabs) {
          if (onDisk.has(path) && (!unsaved[path] || adoptRevision.has(path))) revisions.set(path, onDisk.get(path))
        }
        for (const p of adoptRevision) if (onDisk.has(p)) revisions.set(p, onDisk.get(p))
        adoptRevision.clear()
        // A path a rename, move or delete is changing right now may be read mid-change; that action reconciles it.
        // Environment tabs are not files of the tree; their editor deals with an environment that vanished.
        const present = (p: string): boolean => saved.has(p) || isLocked(p) || environmentIdOf(p) !== null
        const current = get()
        const vanished = current.openTabs.map((t) => t.path).filter((p) => !present(p))
        const vanishedPending = [...pending.keys()].filter((p) => !present(p))
        const lost = [
          ...vanished.map((p) =>
            current.saves[p]
              ? `${p} was removed on disk; unsaved changes were discarded`
              : `${p} was removed on disk; its tab was closed`,
          ),
          ...vanishedPending
            .filter((p) => {
              const e = pending.get(p)!
              return e.version !== e.savedVersion || e.failed !== null
            })
            .map((p) => `${p} was removed on disk; unsaved changes were discarded`),
        ]
        set((s) => {
          const openTabs = s.openTabs.filter((t) => present(t.path))
          const oldIndex = s.openTabs.findIndex((t) => t.path === s.activePath)
          const activeKept = s.activePath !== null && present(s.activePath)
          const drafts: Record<string, RequestItem> = {}
          for (const { path } of openTabs) {
            const baseline = saved.get(path)
            const draft = s.drafts[path]
            if (!baseline) {
              if (draft) drafts[path] = draft
            } else if (!draft || (!s.saves[path] && !sameRequest(draft, baseline))) drafts[path] = baseline
            else if (draft.name !== baseline.name) drafts[path] = { ...draft, name: baseline.name }
            else drafts[path] = draft
          }
          return {
            collections: collections.value.collections,
            loadErrors: collections.value.errors,
            openTabs,
            drafts,
            activePath: activeKept
              ? s.activePath
              : neighbour(openTabs, oldIndex < 0 ? 0 : Math.min(oldIndex, openTabs.length)),
          }
        })
        dropEditing([...vanished, ...vanishedPending], 'removed')
        if (lost.length > 0) set((s) => ({ error: [s.error, ...lost].filter(Boolean).join('. ') }))
        // A dirty draft keeps its edits but must not write an outdated name over a rename done on disk.
        for (const e of [...entries.values(), ...pending.values()]) {
          const name = saved.get(e.path)?.name
          if (name !== undefined && e.draft.name !== name) e.draft = { ...e.draft, name }
        }
      } else {
        fail(collections.reason)
      }
      if (environments.status === 'fulfilled') {
        const list = environments.value.environments
        set((s) => {
          const activeId = s.activeEnvironmentId
          const vanished = activeId !== null && !list.some((e) => e.id === activeId)
          const name = s.environments.find((e) => e.id === activeId)?.name ?? 'selected'
          return {
            environments: list,
            environmentErrors: environments.value.errors,
            activeEnvironmentId: vanished ? null : s.activeEnvironmentId,
            environmentNotice: vanished
              ? `The environment "${name}" is no longer available. No environment is selected.`
              : s.environmentNotice,
          }
        })
      } else if (collections.status === 'fulfilled') {
        fail(environments.reason)
      }
    },

    createCollection: (name) => mutate(() => window.astral.collections.createCollection(name)),
    createFolder: (parentPath, name) =>
      mutate(
        () => window.astral.collections.createFolder(parentPath, name),
        () => get().setExpanded(parentPath, true),
      ),
    createRequest: (parentPath, name) =>
      mutate(
        () => window.astral.collections.createRequest(parentPath, name),
        () => get().setExpanded(parentPath, true),
      ),
    rename: (path, name) =>
      locked(path, () =>
        mutate(
          () => window.astral.collections.rename(path, name),
          (to) => remapTabs(path, to),
          false,
        ),
      ),
    move: (path, parentPath, index) =>
      locked(path, () =>
        mutate(
          () => window.astral.collections.move(path, parentPath, index),
          (to) => {
            remapTabs(path, to)
            get().setExpanded(parentPath, true)
          },
          false,
        ),
      ),
    remove: (path) =>
      locked(path, () =>
        mutate(
          () => window.astral.collections.remove(path),
          () => {
            const s = get()
            const closing = s.activePath !== null && isWithin(s.activePath, path)
            const index = s.openTabs.findIndex((t) => t.path === s.activePath)
            const openTabs = s.openTabs.filter((t) => !isWithin(t.path, path))
            set({
              openTabs,
              activePath: closing ? neighbour(openTabs, Math.min(index, openTabs.length)) : s.activePath,
            })
            dropEditing(
              [...s.openTabs.map((t) => t.path), ...pending.keys()].filter((p) => isWithin(p, path)),
              'removed',
            )
          },
          false,
        ),
      ),

    openRequest(path) {
      const previous = get().activePath
      if (previous !== path) flush(previous)
      // A closed tab's save may still be running: continue from its last draft and queue, not from the stale tree copy.
      const revived = get().drafts[path] ? undefined : pending.get(path)
      let failedWith: string | null = null
      if (revived) {
        pending.delete(path)
        revived.dropped = null
        failedWith = revived.version !== revived.savedVersion ? revived.failed : null
        revived.failed = null
        entries.set(path, revived)
      }
      const fromTree = get().drafts[path] || revived ? null : requestFromTree(get().collections, path)
      // A revived draft keeps the revision its edits are based on.
      if (fromTree) revisions.set(path, revisionFromTree(get().collections, path))
      const baseline = get().drafts[path] ? null : (revived?.draft ?? fromTree)
      const revivedStatus: SaveStatus | null = !revived
        ? null
        : revived.conflict
          ? { state: 'conflict' }
          : failedWith !== null
            ? { state: 'failed', error: failedWith }
            : { state: 'saving' }
      set((s) => ({
        openTabs: s.openTabs.some((t) => t.path === path) ? s.openTabs : [...s.openTabs, { path }],
        activePath: path,
        drafts: baseline ? { ...s.drafts, [path]: baseline } : s.drafts,
        saves: revivedStatus ? { ...s.saves, [path]: revivedStatus } : s.saves,
      }))
    },
    openEnvironment(id, fresh) {
      const tab = environmentTabId(id)
      const previous = get().activePath
      if (previous !== tab) flush(previous)
      let entry = get().environmentDrafts[id]
      if (!entry && fresh) entry = { draft: fresh, baseline: fingerprint(toEnvironment(fresh)) }
      if (!entry) {
        const env = storedEnvironment(id)
        if (!env) return
        entry = { draft: toDraft(env), baseline: fingerprint(env) }
      }
      const opened = entry
      set((s) => ({
        openTabs: s.openTabs.some((t) => t.path === tab) ? s.openTabs : [...s.openTabs, { path: tab }],
        activePath: tab,
        environmentDrafts:
          s.environmentDrafts[id] === opened ? s.environmentDrafts : { ...s.environmentDrafts, [id]: opened },
      }))
    },
    editEnvironmentDraft(id, update) {
      set((s) => {
        const entry = s.environmentDrafts[id]
        return entry ? { environmentDrafts: { ...s.environmentDrafts, [id]: update(entry) } } : s
      })
    },
    closeTab(path, options) {
      if (!get().openTabs.some((t) => t.path === path)) return
      const envId = environmentIdOf(path)
      if (envId !== null) {
        const entry = get().environmentDrafts[envId]
        set((s) => {
          const index = s.openTabs.findIndex((t) => t.path === path)
          const openTabs = s.openTabs.filter((t) => t.path !== path)
          return { openTabs, activePath: s.activePath === path ? neighbour(openTabs, index) : s.activePath }
        })
        const savable =
          entry !== undefined &&
          !options?.discard &&
          isDraftDirty(entry) &&
          draftProblem(entry.draft, get().environments) === null
        if (savable) void writeEnvironmentDraft(envId, entry)
        else set((s) => ({ environmentDrafts: without(s.environmentDrafts, [envId]) }))
        return
      }
      flush(path)
      dropEditing([path], 'closed')
      set((s) => {
        const index = s.openTabs.findIndex((t) => t.path === path)
        const openTabs = s.openTabs.filter((t) => t.path !== path)
        return { openTabs, activePath: s.activePath === path ? neighbour(openTabs, index) : s.activePath }
      })
    },
    editDraft(path, update) {
      const draft = get().drafts[path]
      if (!draft) return
      const next = update(draft)
      const e = entryFor(path, next)
      e.version++
      e.draft = next
      set((s) => ({
        drafts: { ...s.drafts, [path]: next },
        // While in conflict nothing is saved automatically; the edit stays in the draft.
        saves: e.conflict ? s.saves : { ...s.saves, [path]: { state: 'saving' } },
      }))
      if (!e.conflict) schedule(e)
    },
    saveNow(path) {
      const e = entries.get(path)
      return e ? runSave(e) : Promise.resolve()
    },
    flushSave: flush,
    flushAllSaves() {
      for (const e of entries.values()) if (e.timer) void runSave(e)
    },
    unsavedPaths() {
      return [
        ...[...entries.values(), ...pending.values()].filter((e) => e.version !== e.savedVersion).map((e) => e.path),
        ...Object.values(get().environmentDrafts)
          .filter(isDraftDirty)
          .map((e) => `environment "${e.draft.name}"`),
      ]
    },
    async leaveWorkspace(options) {
      const started = epoch
      await get().flushAll()
      if (epoch !== started) return 'left'
      if (!options?.discardUnsaved && get().unsavedPaths().length > 0) return 'unsaved'
      // Nothing that is still in flight may apply to the gate or to the next workspace.
      epoch++
      openSeq++
      resetEditing()
      set(initialState())
      try {
        await window.astral.workspace.close()
      } catch {
        // Main cancels and forgets the workspace when another one is opened anyway.
      }
      return 'left'
    },
    async flushAll() {
      const started = epoch
      // A rename, move or delete first: the saves it deferred resume (under the new path) when it is done.
      while (lockedOps.size > 0) await Promise.allSettled([...lockedOps])
      if (epoch !== started) return
      const all = [...entries.values(), ...pending.values()]
      await Promise.all([
        ...all.map((e) =>
          // A conflict waits for the user's decision; everything else unsaved is written now (failed ones retried).
          !e.conflict && (e.timer || e.deferred || e.version !== e.savedVersion) ? runSave(e) : e.running,
        ),
        // Environment drafts with changes, of open tabs and of closed ones whose save failed.
        ...savableEnvironmentDrafts().map(([id, entry]) => writeEnvironmentDraft(id, entry)),
      ])
    },
    overwriteOnDisk(path) {
      const e = entries.get(path)
      if (!e?.conflict) return Promise.resolve()
      e.conflict = false
      e.overwrite = true
      setSave(path, { state: 'saving' })
      return runSave(e)
    },
    async reloadFromDisk(path) {
      const e = entries.get(path)
      if (!e?.conflict) return
      if (e.timer) clearTimeout(e.timer)
      e.timer = null
      e.conflict = false
      e.overwrite = false
      e.savedVersion = e.version
      // Clean again, so the refresh replaces the draft with the file on disk and takes its revision.
      setSave(path, null)
      await get().refresh()
    },

    async send(path) {
      const s = get()
      const draft = s.drafts[path]
      if (!draft || s.responses[path]?.state === 'sending') return
      flush(path)
      const ticket: SendTicket = { id: globalThis.crypto.randomUUID(), path, dead: false }
      tickets.add(ticket)
      const started = epoch
      const collection = s.collections.find((c) => isWithin(path, c.path))
      set((cur) => ({
        responses: { ...cur.responses, [path]: { state: 'sending' } },
        // A new send starts on the Body tab but keeps the chosen body mode.
        responseViews: {
          ...cur.responseViews,
          [path]: { ...(cur.responseViews[path] ?? DEFAULT_RESPONSE_VIEW), tab: 'body' },
        },
      }))
      try {
        const result = await window.astral.http.send(
          draft,
          { collectionPath: collection?.path ?? null, environmentId: s.activeEnvironmentId },
          ticket.id,
        )
        if (epoch !== started || ticket.dead) return
        set((cur) => ({ responses: { ...cur.responses, [ticket.path]: { state: 'done', result } } }))
      } catch (e) {
        if (epoch !== started || ticket.dead) return
        set((cur) => ({ responses: without(cur.responses, [ticket.path]) }))
        fail(e)
      } finally {
        tickets.delete(ticket)
      }
    },
    async cancelSend(path) {
      const ticket = [...tickets].find((t) => t.path === path && !t.dead)
      if (!ticket) return
      try {
        await window.astral.http.cancel(ticket.id)
      } catch (e) {
        fail(e)
      }
    },
    setResponseView(path, patch) {
      set((s) => ({
        responseViews: {
          ...s.responseViews,
          [path]: { ...(s.responseViews[path] ?? DEFAULT_RESPONSE_VIEW), ...patch },
        },
      }))
    },
    setActiveEnvironment: (id) => set({ activeEnvironmentId: id, environmentNotice: null }),
    saveEnvironment: (env) => environmentCall(() => window.astral.environments.save(env)),
    removeEnvironment: (id) =>
      environmentCall(
        () => window.astral.environments.remove(id),
        () => {
          if (get().activeEnvironmentId === id) set({ activeEnvironmentId: null })
          // Its editor tab goes too, without saving the draft back.
          get().closeTab(environmentTabId(id), { discard: true })
          set((s) => ({ environmentDrafts: without(s.environmentDrafts, [id]) }))
        },
      ),
    dismissEnvironmentNotice: () => set({ environmentNotice: null }),
    setExpanded(path, expanded) {
      set((s) => {
        if (expanded === Boolean(s.expanded[path])) return s
        const { [path]: _removed, ...rest } = s.expanded
        return { expanded: expanded ? { ...rest, [path]: true } : rest }
      })
    },
    dismissError: () => set({ error: null }),
  }
})
