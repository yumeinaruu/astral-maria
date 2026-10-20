import { vi } from 'vitest'
import type { AstralApi } from '../../src/shared/api'
import type { CollectionTree, FolderNode, RequestNode, WorkspaceInfo } from '../../src/shared/types'

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
      ...overrides.collections,
    },
    environments: {
      list: vi.fn().mockResolvedValue({ environments: [], errors: [] }),
      save: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      ...overrides.environments,
    },
    http: {
      send: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      ...overrides.http,
    },
  } as unknown as MockApi
  ;(window as unknown as { astral: unknown }).astral = api
  return api
}
