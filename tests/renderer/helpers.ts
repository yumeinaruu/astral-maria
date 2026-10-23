import { vi } from 'vitest'
import type { AstralApi } from '../../src/shared/api'
import type {
  CollectionTree,
  FolderNode,
  LoadEvent,
  RequestNode,
  RunEvent,
  SyncState,
  WorkspaceInfo,
} from '../../src/shared/types'

export const WS: WorkspaceInfo = { id: 'w1', name: 'Demo workspace', dir: '/tmp/demo' }

/** A workspace folder that is not a git repository. */
export const NOT_LINKED: SyncState = {
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

/** A linked workspace on `main`, in step with the remote, with an identity. */
export function linkedState(over: Partial<SyncState> = {}): SyncState {
  return {
    ...NOT_LINKED,
    linked: true,
    branch: 'main',
    remoteUrl: 'git@example.com:team/apis.git',
    identity: { name: 'Dana', email: 'dana@example.com' },
    ...over,
  }
}

export function requestNode(path: string, name: string, method: RequestNode['request']['method'] = 'GET'): RequestNode {
  return {
    kind: 'request',
    id: `id-${path}`,
    name,
    path,
    request: {
      id: `id-${path}`,
      name,
      method,
      url: '',
      params: [],
      headers: [],
      body: { mode: 'none' },
      auth: { type: 'none' },
    },
    revision: `rev:${path}`,
  }
}

export function folderNode(path: string, name: string, children: FolderNode['children'] = []): FolderNode {
  return { kind: 'folder', id: `id-${path}`, name, path, children }
}

export function collectionTree(path: string, name: string, children: CollectionTree['children'] = []): CollectionTree {
  return { id: `id-${path}`, name, path, variables: [], auth: { type: 'none' }, children }
}

export const FOLDER_PATH = 'collections/shop/users'
export const REQUEST_PATH = 'collections/shop/users/get-users.request.json'

export function sampleTree(): CollectionTree[] {
  return [
    collectionTree('collections/shop', 'Shop', [
      folderNode(FOLDER_PATH, 'Users', [requestNode(REQUEST_PATH, 'Get users', 'GET')]),
    ]),
  ]
}

export type MockApi = { [G in keyof AstralApi]: { [M in keyof AstralApi[G]]: ReturnType<typeof vi.fn> } }

/** A fully mocked `window.astral`; every method resolves with a harmless default. */
export function installApi(overrides: Partial<{ [G in keyof AstralApi]: Partial<MockApi[G]> }> = {}): MockApi {
  const api = {
    workspace: {
      create: vi.fn().mockResolvedValue(WS),
      open: vi.fn().mockResolvedValue(WS),
      pickDirectory: vi.fn().mockResolvedValue('/tmp/demo'),
      recent: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn().mockResolvedValue(WS),
      ...overrides.workspace,
    },
    collections: {
      list: vi.fn().mockResolvedValue({ collections: sampleTree(), errors: [] }),
      createCollection: vi.fn().mockResolvedValue(collectionTree('collections/new', 'New')),
      createFolder: vi.fn().mockResolvedValue(folderNode('collections/shop/f', 'f')),
      createRequest: vi.fn().mockResolvedValue(requestNode('collections/shop/r.request.json', 'r')),
      saveRequest: vi.fn().mockResolvedValue('rev-saved'),
      rename: vi.fn().mockResolvedValue('collections/renamed'),
      remove: vi.fn().mockResolvedValue(undefined),
      move: vi.fn().mockResolvedValue('collections/moved'),
      updateSettings: vi.fn().mockResolvedValue(undefined),
      ...overrides.collections,
    },
    environments: {
      list: vi.fn().mockResolvedValue({ environments: [], errors: [] }),
      save: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      ...overrides.environments,
    },
    transfer: {
      importFiles: vi.fn().mockResolvedValue(null),
      importText: vi.fn().mockResolvedValue({ imported: [], failed: [] }),
      exportCollection: vi.fn().mockResolvedValue('/tmp/out.postman_collection.json'),
      exportEnvironment: vi.fn().mockResolvedValue('/tmp/out.postman_environment.json'),
      ...overrides.transfer,
    },
    http: {
      send: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      ...overrides.http,
    },
    runner: {
      start: vi.fn().mockResolvedValue('run-1'),
      stop: vi.fn().mockResolvedValue(undefined),
      pickDataFile: vi.fn().mockResolvedValue(null),
      saveReport: vi.fn().mockResolvedValue('/tmp/report.json'),
      ...overrides.runner,
    },
    load: {
      start: vi.fn().mockResolvedValue('load-1'),
      stop: vi.fn().mockResolvedValue(undefined),
      saveReport: vi.fn().mockResolvedValue('/tmp/load-report.json'),
      ...overrides.load,
    },
    git: {
      state: vi.fn().mockResolvedValue(NOT_LINKED),
      link: vi.fn().mockResolvedValue(linkedState()),
      unlink: vi.fn().mockResolvedValue(NOT_LINKED),
      fetch: vi.fn().mockResolvedValue(linkedState()),
      clone: vi.fn().mockResolvedValue(null),
      setIdentity: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue({ kind: 'up_to_date' }),
      pull: vi.fn().mockResolvedValue({ kind: 'up_to_date' }),
      push: vi.fn().mockResolvedValue({ kind: 'up_to_date' }),
      resolve: vi.fn().mockResolvedValue(linkedState()),
      openInEditor: vi.fn().mockResolvedValue(undefined),
      finishMerge: vi.fn().mockResolvedValue({ kind: 'done', pulled: 1, pushed: 0 }),
      abortMerge: vi.fn().mockResolvedValue(linkedState()),
      ...overrides.git,
    },
    app: {
      flushed: vi.fn().mockResolvedValue(undefined),
      ...overrides.app,
    },
  } as unknown as MockApi
  ;(window as unknown as { astral: unknown }).astral = api
  return api
}

export interface MockEvents {
  /** Delivers a runner event to every `onRunEvent` listener, as main's push channel would. */
  emitRun(event: RunEvent): void
  /** Delivers a load test event to every `onLoadEvent` listener. */
  emitLoad(event: LoadEvent): void
  /** How many `onLoadEvent` listeners are subscribed. */
  loadListeners(): number
  /** Asks every `onFlushRequest` listener to flush. */
  requestFlush(): void
  /** How many `onRunEvent` listeners are subscribed. */
  runListeners(): number
}

/** A mocked `window.astralEvents`; remove it with `uninstallEvents`. */
export function installEvents(): MockEvents {
  const run = new Set<(event: RunEvent) => void>()
  const flush = new Set<() => void>()
  const load = new Set<(event: LoadEvent) => void>()
  ;(window as unknown as { astralEvents: unknown }).astralEvents = {
    onFlushRequest(listener: () => void) {
      flush.add(listener)
      return () => flush.delete(listener)
    },
    onRunEvent(listener: (event: RunEvent) => void) {
      run.add(listener)
      return () => run.delete(listener)
    },
    onLoadEvent(listener: (event: LoadEvent) => void) {
      load.add(listener)
      return () => load.delete(listener)
    },
  }
  return {
    emitRun: (event) => {
      for (const l of [...run]) l(event)
    },
    emitLoad: (event) => {
      for (const l of [...load]) l(event)
    },
    loadListeners: () => load.size,
    requestFlush: () => {
      for (const l of [...flush]) l()
    },
    runListeners: () => run.size,
  }
}

export function uninstallEvents(): void {
  delete (window as unknown as { astralEvents?: unknown }).astralEvents
}
