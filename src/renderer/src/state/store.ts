import { create } from 'zustand'
import type { CollectionTree, Environment, LoadError, TreeNode, WorkspaceInfo } from '../../../shared/types'

export interface OpenTab {
  path: string
}

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

  function fail(e: unknown): void {
    const message = messageOf(e)
    if (GATE_ERRORS.some((code) => message.startsWith(code))) {
      epoch++
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
        const present = new Set<string>()
        for (const c of collections.value.collections) requestPaths(c.children, present)
        set((s) => {
          const openTabs = s.openTabs.filter((t) => present.has(t.path))
          const oldIndex = s.openTabs.findIndex((t) => t.path === s.activePath)
          const activeKept = s.activePath !== null && present.has(s.activePath)
          return {
            collections: collections.value.collections,
            loadErrors: collections.value.errors,
            openTabs,
            activePath: activeKept
              ? s.activePath
              : neighbour(openTabs, oldIndex < 0 ? 0 : Math.min(oldIndex, openTabs.length)),
          }
        })
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
      mutate(
        () => window.astral.collections.rename(path, name),
        (to) => remapTabs(path, to),
      ),
    move: (path, parentPath, index) =>
      mutate(
        () => window.astral.collections.move(path, parentPath, index),
        (to) => {
          remapTabs(path, to)
          get().setExpanded(parentPath, true)
        },
      ),
    remove: (path) =>
      mutate(
        () => window.astral.collections.remove(path),
        () => {
          const s = get()
          const closing = s.activePath !== null && isWithin(s.activePath, path)
          const index = s.openTabs.findIndex((t) => t.path === s.activePath)
          const openTabs = s.openTabs.filter((t) => !isWithin(t.path, path))
          set({ openTabs, activePath: closing ? neighbour(openTabs, Math.min(index, openTabs.length)) : s.activePath })
        },
      ),

    openRequest(path) {
      set((s) => ({
        openTabs: s.openTabs.some((t) => t.path === path) ? s.openTabs : [...s.openTabs, { path }],
        activePath: path,
      }))
    },
    closeTab(path) {
      set((s) => {
        const index = s.openTabs.findIndex((t) => t.path === path)
        if (index < 0) return s
        const openTabs = s.openTabs.filter((t) => t.path !== path)
        return { openTabs, activePath: s.activePath === path ? neighbour(openTabs, index) : s.activePath }
      })
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
