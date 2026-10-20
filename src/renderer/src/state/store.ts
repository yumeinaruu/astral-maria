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

export interface OpenTab {
  path: string
}

/** Autosave status of a dirty draft; a path without an entry is saved. */
export interface SaveStatus {
  state: 'saving' | 'failed'
  error?: string
}

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
  error: string | null
  /** Expanded collections and folders by path; kept here so the tree survives re-renders and refreshes. */
  expanded: Record<string, true>
  /** Editable copies of the open requests by path; the tree's `request` is the saved baseline. */
  drafts: Record<string, RequestItem>
  /** Draft paths with changes that are not on disk yet (waiting, saving, or failed). */
  saves: Record<string, SaveStatus>
  /** The latest send per open request. */
  responses: Record<string, ResponseEntry>
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
  closeTab(path: string): void
  /** Replaces the draft of an open request and schedules an autosave. */
  editDraft(path: string, update: (draft: RequestItem) => RequestItem): void
  /** Writes the draft now, also retrying a failed save. */
  saveNow(path: string): Promise<void>
  /** Starts any debounced save of `path` immediately (tab switch, send). */
  flushSave(path: string): void
  /** Starts every debounced save immediately (window unload). */
  flushAllSaves(): void
  send(path: string): Promise<void>
  cancelSend(): Promise<void>
  setActiveEnvironment(id: string | null): void
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
    error: null,
    expanded: {},
    drafts: {},
    saves: {},
    responses: {},
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
  dropped: 'closed' | 'removed' | null
}

/** One in-flight send; `path` follows renames, `dead` marks a closed tab. */
interface SendTicket {
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

  function resetEditing(): void {
    for (const e of entries.values()) if (e.timer) clearTimeout(e.timer)
    entries.clear()
    for (const e of pending.values()) if (e.timer) clearTimeout(e.timer)
    pending.clear()
    tickets.clear()
    locks = []
  }

  function isLocked(path: string): boolean {
    return locks.some((l) => isWithin(path, l))
  }

  function entryFor(path: string, draft: RequestItem): SaveEntry {
    let e = entries.get(path)
    if (!e) {
      e = { path, version: 0, savedVersion: 0, timer: null, running: null, draft, deferred: false, dropped: null }
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
        if (e.dropped === 'closed' && !e.deferred && pending.get(e.path) === e) pending.delete(e.path)
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
    if (e.version === e.savedVersion) return
    const draft = e.draft
    const version = e.version
    const started = epoch
    const path = e.path
    setSave(path, { state: 'saving' })
    try {
      await window.astral.collections.saveRequest(path, draft)
    } catch (err) {
      if (epoch !== started || droppedAs(e) === 'removed') return
      if (droppedAs(e) === 'closed') {
        fail(err)
      } else if (isGateError(err)) {
        fail(err)
      } else {
        setSave(e.path, { state: 'failed', error: messageOf(err) })
      }
      return
    }
    if (epoch !== started || droppedAs(e) === 'removed') return
    if (droppedAs(e) === 'closed') {
      // Nobody watches this draft any more, but the tree must show what is on disk when the request is reopened.
      e.savedVersion = version
      void get().refresh()
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
    }
    for (const t of tickets) if (paths.includes(t.path)) t.dead = true
    set((s) => ({
      drafts: without(s.drafts, paths),
      saves: without(s.saves, paths),
      responses: without(s.responses, paths),
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
    set((s) => ({
      drafts: remapKeys(s.drafts, from, to),
      saves: remapKeys(s.saves, from, to),
      responses: remapKeys(s.responses, from, to),
    }))
  }

  /**
   * Runs `fn` (which renames, moves or deletes `path`) while no save may write below `path`: running saves finish
   * first, saves that come due meanwhile resume afterwards, under the new path if there is one.
   */
  async function locked(path: string, fn: () => Promise<void>): Promise<void> {
    const affected = [...entries.values(), ...pending.values()].filter((e) => isWithin(e.path, path))
    for (const e of affected) if (e.timer) e.deferred = true
    locks.push(path)
    try {
      await Promise.all(affected.map((e) => e.running))
      await fn()
    } finally {
      locks.splice(locks.indexOf(path), 1)
      for (const e of [...entries.values(), ...pending.values()]) {
        if (e.deferred && !isLocked(e.path)) {
          e.deferred = false
          void runSave(e)
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
  async function mutate<T>(call: () => Promise<T>, apply?: (result: T) => void): Promise<void> {
    const started = epoch
    try {
      const result = await call()
      if (epoch !== started) return
      apply?.(result)
    } catch (e) {
      if (epoch !== started) return
      fail(e)
    }
    await get().refresh()
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
        for (const c of collections.value.collections) requestsByPath(c.children, saved)
        const vanished = get()
          .openTabs.map((t) => t.path)
          .filter((p) => !saved.has(p))
        set((s) => {
          const openTabs = s.openTabs.filter((t) => saved.has(t.path))
          const oldIndex = s.openTabs.findIndex((t) => t.path === s.activePath)
          const activeKept = s.activePath !== null && saved.has(s.activePath)
          const drafts: Record<string, RequestItem> = {}
          for (const { path } of openTabs) {
            const baseline = saved.get(path)!
            const draft = s.drafts[path]
            if (!draft || (!s.saves[path] && !sameRequest(draft, baseline))) drafts[path] = baseline
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
        dropEditing(vanished, 'removed')
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
        set((s) => ({
          environments: list,
          activeEnvironmentId: list.some((e) => e.id === s.activeEnvironmentId) ? s.activeEnvironmentId : null,
        }))
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
        ),
      ),

    openRequest(path) {
      const previous = get().activePath
      if (previous !== path) flush(previous)
      // A closed tab's save may still be running: continue from its last draft and queue, not from the stale tree copy.
      const revived = get().drafts[path] ? undefined : pending.get(path)
      if (revived) {
        pending.delete(path)
        revived.dropped = null
        entries.set(path, revived)
      }
      const baseline = get().drafts[path] ? null : (revived?.draft ?? requestFromTree(get().collections, path))
      set((s) => ({
        openTabs: s.openTabs.some((t) => t.path === path) ? s.openTabs : [...s.openTabs, { path }],
        activePath: path,
        drafts: baseline ? { ...s.drafts, [path]: baseline } : s.drafts,
        saves: revived ? { ...s.saves, [path]: { state: 'saving' } } : s.saves,
      }))
    },
    closeTab(path) {
      if (!get().openTabs.some((t) => t.path === path)) return
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
        saves: { ...s.saves, [path]: { state: 'saving' } },
      }))
      schedule(e)
    },
    saveNow(path) {
      const e = entries.get(path)
      return e ? runSave(e) : Promise.resolve()
    },
    flushSave: flush,
    flushAllSaves() {
      for (const e of entries.values()) if (e.timer) void runSave(e)
    },

    async send(path) {
      const s = get()
      const draft = s.drafts[path]
      if (!draft || s.responses[path]?.state === 'sending') return
      flush(path)
      const ticket: SendTicket = { path, dead: false }
      tickets.add(ticket)
      const started = epoch
      const collection = s.collections.find((c) => isWithin(path, c.path))
      set((cur) => ({ responses: { ...cur.responses, [path]: { state: 'sending' } } }))
      try {
        const result = await window.astral.http.send(draft, {
          collectionPath: collection?.path ?? null,
          environmentId: s.activeEnvironmentId,
        })
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
    async cancelSend() {
      try {
        await window.astral.http.cancel()
      } catch (e) {
        fail(e)
      }
    },
    setActiveEnvironment: (id) => set({ activeEnvironmentId: id }),
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
