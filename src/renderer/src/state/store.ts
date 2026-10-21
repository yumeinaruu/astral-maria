import { create } from 'zustand'
import type {
  Auth,
  CollectionTree,
  Environment,
  ImportReport,
  HttpMethod,
  KeyValue,
  LoadError,
  RequestItem,
  ScriptLog,
  ScriptPhase,
  Scripts,
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
import { composeUrl } from '../lib/url'
import { MASK } from '../lib/variables'

/**
 * A tab: the path of a request, the path of a collection or folder (its settings; see `containerDrafts`), or
 * `env:<id>` (see `environmentTabId`) for an environment editor.
 */
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
 * The editable settings of a collection or folder tab. Folders have only scripts; their `variables` and `auth` are
 * unused.
 */
export interface ContainerSettings {
  kind: 'collection' | 'folder'
  name: string
  scripts?: Scripts
  variables: KeyValue[]
  auth: Auth
}

/**
 * Autosave status of a dirty draft; a path without an entry is saved. `conflict`: the file changed on disk since the
 * draft's baseline was read; nothing is saved until the user picks Overwrite or Reload from disk.
 */
export interface SaveStatus {
  state: 'saving' | 'failed' | 'conflict'
  error?: string
}

export type ResponseTab = 'body' | 'headers' | 'cookies' | 'tests'
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

/** One line of the console: a send, a script's console output, or a script that failed. */
export type ConsoleLine =
  | {
      id: number
      kind: 'request'
      method: HttpMethod
      /** The URL the response came from, or the unresolved draft URL when nothing was received. */
      url: string
      status?: number
      ms?: number
      /** The error code of a send that got no response. */
      error?: string
    }
  | ({ id: number; kind: 'log' } & ScriptLog)
  | { id: number; kind: 'failure'; phase: ScriptPhase; source: string; message: string }

/** The console keeps this many lines; older ones are dropped. */
export const CONSOLE_LIMIT = 500

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
  /** Settings drafts of the open collection and folder tabs, by path; a tab is a container tab iff it has one. */
  containerDrafts: Record<string, ContainerSettings>
  /** What the sends of this workspace session did, oldest first; at most `CONSOLE_LIMIT` lines. */
  consoleLines: ConsoleLine[]
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
  /** Opens (or activates) the settings tab of the collection or folder at `path`. */
  openContainer(path: string): void
  /** Replaces the settings draft of an open collection or folder tab and schedules an autosave. */
  editContainerDraft(path: string, update: (draft: ContainerSettings) => ContainerSettings): void
  /** Opens (or activates) the editor tab of the stored environment `id` (or of the empty globals set). */
  openEnvironment(id: string): void
  /** Replaces the draft of an open environment tab; nothing is saved until Save, closing the tab, or `flushAll`. */
  editEnvironmentDraft(id: string, update: (entry: EnvironmentDraft) => EnvironmentDraft): void
  /**
   * Closes a request or environment tab. A changed environment draft is saved, like a request's; one that cannot be
   * saved (invalid), or any with `discard`, is dropped.
   */
  closeTab(path: string, options?: { discard?: boolean }): void
  /** Replaces the draft of an open request and schedules an autosave. */
  editDraft(path: string, update: (draft: RequestItem) => RequestItem): void
  /** Writes the draft (of a request, collection or folder) now, also retrying a failed save. */
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
  /**
   * Opens the file dialog and imports the chosen files; null when it was cancelled. Collections and environments are
   * reloaded when anything was imported, and new collections are expanded. A rejected call becomes a failed line.
   */
  importFiles(): Promise<ImportReport | null>
  /** Imports one file's text (dropped or pasted, named by `source`); reloads like `importFiles`. */
  importText(text: string, source: string): Promise<ImportReport>
  /** Writes every unsaved draft (as `flushAll`), then exports the collection; a failure goes to the error banner. */
  exportCollection(path: string): Promise<void>
  /** Exports the environment as it is saved on disk (an open draft is not written first); failures as above. */
  exportEnvironment(id: string): Promise<void>
  setExpanded(path: string, expanded: boolean): void
  dismissError(): void
  clearConsole(): void
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
    containerDrafts: {},
    consoleLines: [],
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

/**
 * Autosave bookkeeping of a collection or folder settings tab. `path` follows renames; `version` counts edits. After
 * the tab is closed (`open: false`) the entry stays until its last save has settled.
 */
interface ContainerEntry {
  path: string
  version: number
  savedVersion: number
  timer: ReturnType<typeof setTimeout> | null
  running: Promise<void> | null
  draft: ContainerSettings
  deferred: boolean
  open: boolean
  removed: boolean
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

/** The saved settings of the collection or folder at `path`, or null if there is none. */
export function containerFromTree(collections: CollectionTree[], path: string): ContainerSettings | null {
  const walk = (nodes: TreeNode[]): ContainerSettings | null => {
    for (const n of nodes) {
      if (n.kind !== 'folder' || !isWithin(path, n.path)) continue
      if (n.path === path) {
        return {
          kind: 'folder',
          name: n.name,
          ...(n.scripts && { scripts: n.scripts }),
          variables: [],
          auth: { type: 'none' },
        }
      }
      return walk(n.children)
    }
    return null
  }
  for (const c of collections) {
    if (c.path === path) {
      return {
        kind: 'collection',
        name: c.name,
        ...(c.scripts && { scripts: c.scripts }),
        variables: c.variables,
        auth: c.auth,
      }
    }
    if (isWithin(path, c.path)) return walk(c.children)
  }
  return null
}

function containerPaths(nodes: TreeNode[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.kind === 'folder') {
      into.add(node.path)
      containerPaths(node.children, into)
    }
  }
  return into
}

const NO_SCRIPTS: Scripts = { preRequest: '', postResponse: '' }

/**
 * The `updateSettings` patch that turns `saved` into `draft`: only the fields that differ, and only scripts for a
 * folder. Removed scripts are written as empty strings, since a missing field means "unchanged".
 */
export function settingsPatch(
  saved: ContainerSettings | null,
  draft: ContainerSettings,
): { scripts?: Scripts; variables?: KeyValue[]; auth?: Auth } {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  const scripts = draft.scripts ?? NO_SCRIPTS
  const patch: { scripts?: Scripts; variables?: KeyValue[]; auth?: Auth } = {}
  if (!saved || !same(saved.scripts ?? NO_SCRIPTS, scripts)) patch.scripts = scripts
  if (draft.kind === 'collection') {
    if (!saved || !same(saved.variables, draft.variables)) patch.variables = draft.variables
    if (!saved || !same(saved.auth, draft.auth)) patch.auth = draft.auth
  }
  return patch
}

/** Secrets shorter than this are not masked: they would hide ordinary text. */
const MIN_MASKED = 4

/**
 * Replaces every secret value (of 4 or more characters) of the active environment and of the globals in `text` with
 * `••••`, also in its URL-encoded form; longest first, so a secret that contains another is masked whole.
 */
export function maskSecrets(text: string, environments: Environment[], activeEnvironmentId: string | null): string {
  const secrets = new Set<string>()
  for (const env of environments) {
    if (env.id !== GLOBALS_ID && env.id !== activeEnvironmentId) continue
    for (const v of env.variables) {
      if (!v.secret) continue
      const value = v.currentValue ? v.currentValue : v.value
      if (value.length < MIN_MASKED) continue
      secrets.add(value)
      secrets.add(encodeURIComponent(value))
    }
  }
  let masked = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) masked = masked.split(secret).join(MASK)
  return masked
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
  /** Autosave state of the collection and folder settings tabs, by path. */
  const containerEntries = new Map<string, ContainerEntry>()
  let consoleSeq = 0

  /**
   * Adds the lines of one send to the console. Request headers are never logged. The URL is the one the response came
   * from, with the secrets of the active environment and the globals masked, or the unresolved draft URL.
   */
  function logSend(draft: RequestItem, result: SendResult): void {
    const { environments, activeEnvironmentId } = get()
    const request: ConsoleLine = result.ok
      ? {
          id: ++consoleSeq,
          kind: 'request',
          method: draft.method,
          url: maskSecrets(result.response.finalUrl, environments, activeEnvironmentId),
          status: result.response.status,
          ms: result.response.totalMs,
        }
      : {
          id: ++consoleSeq,
          kind: 'request',
          method: draft.method,
          url: composeUrl(draft.url, draft.params),
          error: result.error.code,
        }
    const scripts = result.scripts
    const added: ConsoleLine[] = [
      request,
      ...(scripts?.logs ?? []).map((l): ConsoleLine => ({ id: ++consoleSeq, kind: 'log', ...l })),
      ...(scripts?.failures ?? []).map((f): ConsoleLine => ({ id: ++consoleSeq, kind: 'failure', ...f })),
    ]
    set((s) => ({ consoleLines: [...s.consoleLines, ...added].slice(-CONSOLE_LIMIT) }))
  }

  function resetEditing(): void {
    for (const e of entries.values()) if (e.timer) clearTimeout(e.timer)
    entries.clear()
    for (const e of pending.values()) if (e.timer) clearTimeout(e.timer)
    pending.clear()
    for (const e of containerEntries.values()) if (e.timer) clearTimeout(e.timer)
    containerEntries.clear()
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

  /** Writes the settings draft of `e`, after any save already running for it. */
  function runContainerSave(e: ContainerEntry): Promise<void> {
    if (e.timer) clearTimeout(e.timer)
    e.timer = null
    const task = e.running ? e.running.then(() => doContainerSave(e)) : doContainerSave(e)
    const tracked: Promise<void> = task.finally(() => {
      if (e.running !== tracked) return
      e.running = null
      // A closed tab's entry is forgotten once nothing is left to save for it; a failed one is kept, so reopening
      // the tab recovers its draft and `flushAll` retries it.
      if (!e.open && !e.deferred && e.version === e.savedVersion && containerEntries.get(e.path) === e) {
        containerEntries.delete(e.path)
      }
    })
    e.running = tracked
    return tracked
  }

  function scheduleContainer(e: ContainerEntry): void {
    if (e.timer) clearTimeout(e.timer)
    e.timer = setTimeout(() => void runContainerSave(e), AUTOSAVE_DELAY_MS)
  }

  async function doContainerSave(e: ContainerEntry): Promise<void> {
    if (e.removed) return
    if (isLocked(e.path)) {
      e.deferred = true
      return
    }
    if (e.version === e.savedVersion) {
      if (e.open) setSave(e.path, null)
      return
    }
    const version = e.version
    const path = e.path
    const started = epoch
    const patch = settingsPatch(containerFromTree(get().collections, path), e.draft)
    if (e.open) setSave(path, { state: 'saving' })
    try {
      if (Object.keys(patch).length > 0) await window.astral.collections.updateSettings(path, patch)
    } catch (err) {
      if (epoch !== started || e.removed) return
      if (isGateError(err)) fail(err)
      else if (e.open) setSave(e.path, { state: 'failed', error: messageOf(err) })
      else set({ error: `Could not save the settings of ${e.path}: ${messageOf(err)}` })
      return
    }
    if (epoch !== started || e.removed) return
    e.savedVersion = version
    if (e.version === version && e.open) setSave(e.path, null)
    // The tree is the saved baseline (and what sends use); reload it.
    await get().refresh()
  }

  /**
   * Writes the pending or running settings saves of the collection and folders that contain `path` and waits for
   * them. Null when there is nothing to wait for (so the send starts synchronously); otherwise resolves null when all of
   * them are on disk, else the message why the request is not sent.
   */
  function saveSettingsAbove(path: string): Promise<string | null> | null {
    const above = [...containerEntries.values()].filter(
      (e) =>
        e.path !== path &&
        isWithin(path, e.path) &&
        (e.timer || e.deferred || e.running || e.version !== e.savedVersion),
    )
    if (above.length === 0) return null
    return Promise.all(
      above.map((e) => (e.timer || e.deferred || e.version !== e.savedVersion ? runContainerSave(e) : e.running)),
    ).then(() => {
      const failed = above.find((e) => !e.removed && e.version !== e.savedVersion)
      if (!failed) return null
      const reason = get().saves[failed.path]?.error
      return `The request was not sent: the settings of ${failed.path} could not be saved${reason ? ` (${reason})` : ''}`
    })
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
      const c = containerEntries.get(p)
      if (c && reason === 'removed') {
        if (c.timer) clearTimeout(c.timer)
        c.timer = null
        c.removed = true
        containerEntries.delete(p)
      }
    }
    for (const t of tickets) if (paths.includes(t.path)) t.dead = true
    set((s) => ({
      containerDrafts: reason === 'removed' ? without(s.containerDrafts, paths) : s.containerDrafts,
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
    for (const [p, e] of [...containerEntries]) {
      if (!isWithin(p, from)) continue
      containerEntries.delete(p)
      e.path = remapPath(p, from, to)
      containerEntries.set(e.path, e)
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
      containerDrafts: remapKeys(s.containerDrafts, from, to),
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
    const affectedContainers = [...containerEntries.values()].filter((e) => isWithin(e.path, path))
    for (const e of affectedContainers) if (e.timer) e.deferred = true
    const started = epoch
    locks.push(path)
    // A refresh already in flight may read the disk mid-change and then apply after it; its result is discarded.
    refreshSeq++
    try {
      await Promise.all([...affected, ...affectedContainers].map((e) => e.running))
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
        for (const e of [...containerEntries.values()]) {
          if (e.deferred && !isLocked(e.path)) {
            e.deferred = false
            void runContainerSave(e)
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
    const c = containerEntries.get(path)
    if (c?.timer) void runContainerSave(c)
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
          [id]: { draft: { ...current.draft, name: env.name }, baseline: fingerprint(env) },
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

  /** Runs an import call; reloads (and expands new collections) when it imported something. */
  async function runImport<T extends ImportReport | null>(call: () => Promise<T>, source: string): Promise<T> {
    const started = epoch
    let report: T
    try {
      report = await call()
    } catch (e) {
      if (epoch === started && isGateError(e)) fail(e)
      return { imported: [], failed: [{ source, message: messageOf(e) }] } as ImportReport as T
    }
    if (epoch !== started || !report || report.imported.length === 0) return report
    const before = new Set(get().collections.map((c) => c.path))
    await get().refresh()
    if (epoch !== started) return report
    for (const c of get().collections) if (!before.has(c.path)) get().setExpanded(c.path, true)
    return report
  }

  /** Runs an export; a rejection (other than a lost workspace) is shown as `Could not export "<name>"`. */
  async function runExport(name: string, call: () => Promise<unknown>): Promise<void> {
    const started = epoch
    try {
      await call()
    } catch (e) {
      if (epoch !== started) return
      if (isGateError(e)) fail(e)
      else set({ error: `Could not export "${name}": ${messageOf(e)}` })
    }
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
        const containers = new Set<string>()
        for (const c of collections.value.collections) {
          requestsByPath(c.children, saved)
          revisionsByPath(c.children, onDisk)
          containers.add(c.path)
          containerPaths(c.children, containers)
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
        const present = (p: string): boolean =>
          saved.has(p) || containers.has(p) || isLocked(p) || environmentIdOf(p) !== null
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
          // Settings tabs: a clean draft follows the disk; a dirty one keeps its edits but takes a new name.
          const containerDrafts: Record<string, ContainerSettings> = {}
          for (const { path } of openTabs) {
            const draft = s.containerDrafts[path]
            if (!draft) continue
            const baseline = containerFromTree(collections.value.collections, path)
            if (!baseline) containerDrafts[path] = draft
            else if (!s.saves[path]) containerDrafts[path] = baseline
            else containerDrafts[path] = { ...draft, name: baseline.name }
          }
          return {
            collections: collections.value.collections,
            containerDrafts,
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
              [...s.openTabs.map((t) => t.path), ...pending.keys(), ...containerEntries.keys()].filter((p) =>
                isWithin(p, path),
              ),
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
    openContainer(path) {
      const previous = get().activePath
      if (previous !== path) flush(previous)
      let draft: ContainerSettings | null = get().containerDrafts[path] ?? null
      let status: SaveStatus | null = null
      if (!draft) {
        // A closed tab whose save is still running or waiting: continue from its draft.
        const revived = containerEntries.get(path)
        if (revived && !revived.open) {
          revived.open = true
          draft = revived.draft
          if (revived.version !== revived.savedVersion) {
            // Its last save may have failed; it is retried like a fresh edit.
            status = { state: 'saving' }
            if (!revived.running) scheduleContainer(revived)
          }
        } else {
          draft = containerFromTree(get().collections, path)
        }
      }
      if (!draft) return
      const opened = draft
      set((s) => ({
        openTabs: s.openTabs.some((t) => t.path === path) ? s.openTabs : [...s.openTabs, { path }],
        activePath: path,
        containerDrafts:
          s.containerDrafts[path] === opened ? s.containerDrafts : { ...s.containerDrafts, [path]: opened },
        saves: status ? { ...s.saves, [path]: status } : s.saves,
      }))
    },
    editContainerDraft(path, update) {
      const draft = get().containerDrafts[path]
      if (!draft) return
      const next = update(draft)
      let e = containerEntries.get(path)
      if (!e) {
        e = {
          path,
          version: 0,
          savedVersion: 0,
          timer: null,
          running: null,
          draft: next,
          deferred: false,
          open: true,
          removed: false,
        }
        containerEntries.set(path, e)
      }
      e.version++
      e.draft = next
      set((s) => ({
        containerDrafts: { ...s.containerDrafts, [path]: next },
        saves: { ...s.saves, [path]: { state: 'saving' } },
      }))
      scheduleContainer(e)
    },
    openEnvironment(id) {
      const tab = environmentTabId(id)
      const previous = get().activePath
      if (previous !== tab) flush(previous)
      let entry = get().environmentDrafts[id]
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
      if (get().containerDrafts[path]) {
        // A pending change is written now; the entry stays until that save has settled.
        const e = containerEntries.get(path)
        if (e) {
          e.open = false
          if (options?.discard) {
            if (e.timer) clearTimeout(e.timer)
            e.timer = null
            e.savedVersion = e.version
            if (!e.running) containerEntries.delete(path)
          } else {
            void runContainerSave(e)
          }
        }
        set((s) => {
          const index = s.openTabs.findIndex((t) => t.path === path)
          const openTabs = s.openTabs.filter((t) => t.path !== path)
          return {
            openTabs,
            activePath: s.activePath === path ? neighbour(openTabs, index) : s.activePath,
            containerDrafts: without(s.containerDrafts, [path]),
            saves: without(s.saves, [path]),
          }
        })
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
      if (e) return runSave(e)
      const c = containerEntries.get(path)
      return c ? runContainerSave(c) : Promise.resolve()
    },
    flushSave: flush,
    flushAllSaves() {
      for (const e of entries.values()) if (e.timer) void runSave(e)
      for (const e of containerEntries.values()) if (e.timer) void runContainerSave(e)
    },
    unsavedPaths() {
      return [
        ...[...entries.values(), ...pending.values(), ...containerEntries.values()]
          .filter((e) => e.version !== e.savedVersion)
          .map((e) => e.path),
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
        ...[...containerEntries.values()].map((e) =>
          e.timer || e.deferred || e.version !== e.savedVersion ? runContainerSave(e) : e.running,
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
        // The scripts, auth and variables of the collection and folders above the request are read from disk: a
        // pending or running save of their settings is written first, and the send stops if one cannot be.
        const saving = saveSettingsAbove(path)
        if (saving) {
          const unsaved = await saving
          if (epoch !== started || ticket.dead) return
          if (unsaved !== null) {
            set((cur) => ({ responses: without(cur.responses, [ticket.path]), error: unsaved }))
            return
          }
        }
        const result = await window.astral.http.send(
          draft,
          { collectionPath: collection?.path ?? null, environmentId: s.activeEnvironmentId, requestPath: path },
          ticket.id,
        )
        if (epoch !== started) return
        // Scripts saved new current values; open environment editors follow (or flag) them on the reload, and the
        // console masks the secrets they set.
        if (result.scripts && result.scripts.changedEnvironmentIds.length > 0) {
          await get().refresh()
          if (epoch !== started) return
        }
        logSend(draft, result)
        if (ticket.dead) return
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
    importFiles: () => runImport(() => window.astral.transfer.importFiles(), 'Selected files'),
    importText: (text, source) => runImport(() => window.astral.transfer.importText(text, source), source),
    async exportCollection(path) {
      const started = epoch
      await get().flushAll()
      if (epoch !== started) return
      const name = get().collections.find((c) => c.path === path)?.name ?? path
      await runExport(name, () => window.astral.transfer.exportCollection(path))
    },
    exportEnvironment(id) {
      const name = storedEnvironment(id)?.name ?? id
      return runExport(name, () => window.astral.transfer.exportEnvironment(id))
    },
    setExpanded(path, expanded) {
      set((s) => {
        if (expanded === Boolean(s.expanded[path])) return s
        const { [path]: _removed, ...rest } = s.expanded
        return { expanded: expanded ? { ...rest, [path]: true } : rest }
      })
    },
    dismissError: () => set({ error: null }),
    clearConsole: () => set({ consoleLines: [] }),
  }
})
