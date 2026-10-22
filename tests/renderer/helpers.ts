import { vi } from 'vitest'
import type { AstralApi } from '../../src/shared/api'
import type { CollectionTree, FolderNode, RequestNode, RunEvent, WorkspaceInfo } from '../../src/shared/types'

export const WS: WorkspaceInfo = { id: 'w1', name: 'Demo workspace', dir: '/tmp/demo' }

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
  /** Asks every `onFlushRequest` listener to flush. */
  requestFlush(): void
  /** How many `onRunEvent` listeners are subscribed. */
  runListeners(): number
}

/** A mocked `window.astralEvents`; remove it with `uninstallEvents`. */
export function installEvents(): MockEvents {
  const run = new Set<(event: RunEvent) => void>()
  const flush = new Set<() => void>()
  ;(window as unknown as { astralEvents: unknown }).astralEvents = {
    onFlushRequest(listener: () => void) {
      flush.add(listener)
      return () => flush.delete(listener)
    },
    onRunEvent(listener: (event: RunEvent) => void) {
      run.add(listener)
      return () => run.delete(listener)
    },
  }
  return {
    emitRun: (event) => {
      for (const l of [...run]) l(event)
    },
    requestFlush: () => {
      for (const l of [...flush]) l()
    },
    runListeners: () => run.size,
  }
}

export function uninstallEvents(): void {
  delete (window as unknown as { astralEvents?: unknown }).astralEvents
}
