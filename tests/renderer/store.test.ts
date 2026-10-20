// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { useApp, initialState } from '../../src/renderer/src/state/store'
import {
  collectionTree,
  FOLDER_PATH,
  folderNode,
  installApi,
  REQUEST_PATH,
  requestNode,
  sampleTree,
  WS,
} from './helpers'

beforeEach(() => {
  useApp.setState(initialState())
})

async function openDemo() {
  await useApp.getState().openWorkspace('/tmp/demo')
}

describe('store', () => {
  it('opens a workspace and loads collections and environments', async () => {
    const api = installApi()
    await openDemo()
    expect(api.workspace.open).toHaveBeenCalledWith('/tmp/demo')
    expect(useApp.getState().workspace).toEqual(WS)
    expect(useApp.getState().collections).toHaveLength(1)
    expect(api.environments.list).toHaveBeenCalled()
  })

  it('keeps the error and the previous tree when refresh fails, and returns to the gate when the workspace is gone', async () => {
    const api = installApi()
    await openDemo()
    api.collections.list.mockRejectedValue(new Error('boom'))
    await useApp.getState().refresh()
    expect(useApp.getState().error).toBe('boom')
    expect(useApp.getState().collections).toHaveLength(1)
    expect(useApp.getState().workspace).toEqual(WS)

    api.collections.list.mockRejectedValue(new Error('workspace_unavailable: cannot read workspace'))
    await useApp.getState().refresh()
    expect(useApp.getState().workspace).toBeNull()
    expect(useApp.getState().error).toMatch(/^workspace_unavailable/)
  })

  it('catches action failures into error and refreshes', async () => {
    const api = installApi()
    await openDemo()
    api.collections.createFolder.mockRejectedValue(new Error('nope'))
    api.collections.list.mockClear()
    await useApp.getState().createFolder('collections/shop', 'x')
    expect(useApp.getState().error).toBe('nope')
    expect(api.collections.list).toHaveBeenCalledTimes(1)
  })

  it('refreshes after a successful action', async () => {
    const api = installApi()
    await openDemo()
    api.collections.list.mockClear()
    await useApp.getState().createCollection('Foo')
    expect(api.collections.createCollection).toHaveBeenCalledWith('Foo')
    expect(api.collections.list).toHaveBeenCalledTimes(1)
    expect(useApp.getState().error).toBeNull()
  })

  it('opens requests as tabs, activates them and picks a neighbour when closing', async () => {
    installApi()
    await openDemo()
    const s = useApp.getState()
    s.openRequest('a')
    s.openRequest('b')
    s.openRequest('c')
    s.openRequest('a')
    expect(useApp.getState().openTabs.map((t) => t.path)).toEqual(['a', 'b', 'c'])
    expect(useApp.getState().activePath).toBe('a')
    useApp.getState().openRequest('b')
    useApp.getState().closeTab('b')
    expect(useApp.getState().activePath).toBe('c')
    useApp.getState().closeTab('c')
    expect(useApp.getState().activePath).toBe('a')
    useApp.getState().closeTab('a')
    expect(useApp.getState().activePath).toBeNull()
  })

  it('drops tabs whose request disappeared after a refresh', async () => {
    const api = installApi()
    await openDemo()
    useApp.getState().openRequest(REQUEST_PATH)
    useApp.getState().openRequest('collections/shop/gone.request.json')
    expect(useApp.getState().activePath).toBe('collections/shop/gone.request.json')
    await useApp.getState().refresh()
    expect(useApp.getState().openTabs.map((t) => t.path)).toEqual([REQUEST_PATH])
    expect(useApp.getState().activePath).toBe(REQUEST_PATH)
    api.collections.list.mockResolvedValue({ collections: [], errors: [] })
    await useApp.getState().refresh()
    expect(useApp.getState().openTabs).toEqual([])
    expect(useApp.getState().activePath).toBeNull()
  })

  it('remaps open tabs, including descendants, when a folder is renamed', async () => {
    const api = installApi()
    await openDemo()
    useApp.getState().openRequest(REQUEST_PATH)
    api.collections.rename.mockResolvedValue('collections/shop/people')
    api.collections.list.mockResolvedValue({
      collections: [
        collectionTree('collections/shop', 'Shop', [
          folderNode('collections/shop/people', 'People', [
            requestNode('collections/shop/people/get-users.request.json', 'Get users'),
          ]),
        ]),
      ],
      errors: [],
    })
    await useApp.getState().rename(FOLDER_PATH, 'People')
    expect(useApp.getState().openTabs.map((t) => t.path)).toEqual(['collections/shop/people/get-users.request.json'])
    expect(useApp.getState().activePath).toBe('collections/shop/people/get-users.request.json')
  })

  it('remaps tabs when an item is moved and closes tabs of removed items', async () => {
    const api = installApi()
    await openDemo()
    useApp.getState().openRequest(REQUEST_PATH)
    api.collections.move.mockResolvedValue('collections/shop/get-users.request.json')
    api.collections.list.mockResolvedValue({
      collections: [
        collectionTree('collections/shop', 'Shop', [
          requestNode('collections/shop/get-users.request.json', 'Get users'),
        ]),
      ],
      errors: [],
    })
    await useApp.getState().move(REQUEST_PATH, 'collections/shop', 0)
    expect(api.collections.move).toHaveBeenCalledWith(REQUEST_PATH, 'collections/shop', 0)
    expect(useApp.getState().activePath).toBe('collections/shop/get-users.request.json')

    api.collections.list.mockResolvedValue({ collections: sampleTree(), errors: [] })
    await useApp.getState().remove('collections/shop/get-users.request.json')
    expect(useApp.getState().openTabs).toEqual([])
  })

  it('tracks expanded state and the active environment', async () => {
    installApi()
    await openDemo()
    useApp.getState().setExpanded('collections/shop', true)
    expect(useApp.getState().expanded['collections/shop']).toBe(true)
    useApp.getState().setExpanded('collections/shop', false)
    expect(useApp.getState().expanded['collections/shop']).toBeFalsy()
    useApp.getState().setActiveEnvironment('e1')
    expect(useApp.getState().activeEnvironmentId).toBe('e1')
  })

  it('clears a stale active environment after refresh', async () => {
    installApi()
    await openDemo()
    useApp.getState().setActiveEnvironment('gone')
    await useApp.getState().refresh()
    expect(useApp.getState().activeEnvironmentId).toBeNull()
  })
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('store races', () => {
  it('lets only the latest refresh apply its result', async () => {
    const api = installApi()
    await openDemo()
    const first = deferred<{ collections: ReturnType<typeof sampleTree>; errors: [] }>()
    const second = deferred<{ collections: ReturnType<typeof sampleTree>; errors: [] }>()
    api.collections.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const p1 = useApp.getState().refresh()
    const p2 = useApp.getState().refresh()
    second.resolve({ collections: [collectionTree('collections/new', 'Newer')], errors: [] })
    await p2
    first.resolve({ collections: [collectionTree('collections/old', 'Older')], errors: [] })
    await p1
    expect(useApp.getState().collections.map((c) => c.name)).toEqual(['Newer'])
  })

  it('discards the error of a stale refresh', async () => {
    const api = installApi()
    await openDemo()
    let reject!: (e: Error) => void
    api.collections.list.mockReturnValueOnce(new Promise((_, r) => (reject = r)))
    const p1 = useApp.getState().refresh()
    await useApp.getState().refresh()
    reject(new Error('stale failure'))
    await p1
    expect(useApp.getState().error).toBeNull()
  })

  it('ignores an action that resolves after the workspace was replaced', async () => {
    const api = installApi()
    await openDemo()
    const slow = deferred<string>()
    api.collections.rename.mockReturnValueOnce(slow.promise)
    const pending = useApp.getState().rename(FOLDER_PATH, 'People')
    api.workspace.open.mockResolvedValue({ id: 'w2', name: 'Other', dir: '/tmp/other' })
    await useApp.getState().openWorkspace('/tmp/other')
    useApp.getState().openRequest(REQUEST_PATH)
    api.collections.list.mockClear()
    slow.resolve('collections/shop/people')
    await pending
    const s = useApp.getState()
    expect(s.workspace?.id).toBe('w2')
    expect(s.openTabs.map((t) => t.path)).toEqual([REQUEST_PATH])
    expect(s.collections.map((c) => c.name)).toEqual(['Shop'])
    expect(s.error).toBeNull()
    expect(api.collections.list).not.toHaveBeenCalled()
  })

  it('ignores a failing action that settles after the workspace was replaced', async () => {
    const api = installApi()
    await openDemo()
    const slow = deferred<string>()
    api.collections.rename.mockReturnValueOnce(slow.promise.then(() => Promise.reject(new Error('late'))))
    const pending = useApp.getState().rename(FOLDER_PATH, 'x')
    await useApp.getState().openWorkspace('/tmp/other')
    slow.resolve('')
    await pending
    expect(useApp.getState().error).toBeNull()
  })
})
