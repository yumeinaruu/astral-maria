// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialState, useApp } from '../../src/renderer/src/state/store'
import type { RequestItem, SendResult } from '../../src/shared/types'
import { collectionTree, folderNode, installApi, REQUEST_PATH, requestNode, type MockApi } from './helpers'

beforeEach(() => {
  vi.useFakeTimers()
  useApp.setState(initialState())
})
afterEach(() => {
  vi.useRealTimers()
})

const OTHER_PATH = 'collections/shop/users/other.request.json'

function treeWith(...requests: ReturnType<typeof requestNode>[]) {
  return {
    collections: [
      collectionTree('collections/shop', 'Shop', [folderNode('collections/shop/users', 'Users', requests)]),
    ],
    errors: [],
  }
}

async function setup(overrides: Parameters<typeof installApi>[0] = {}): Promise<MockApi> {
  const api = installApi({
    ...overrides,
    collections: {
      list: vi
        .fn()
        .mockResolvedValue(treeWith(requestNode(REQUEST_PATH, 'Get users'), requestNode(OTHER_PATH, 'Other'))),
      ...overrides.collections,
    },
  })
  await useApp.getState().openWorkspace('/tmp/demo')
  useApp.getState().openRequest(REQUEST_PATH)
  return api
}

const setUrl = (path: string, url: string) => useApp.getState().editDraft(path, (r) => ({ ...r, url }))
const draft = (path = REQUEST_PATH): RequestItem => useApp.getState().drafts[path]!
const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('drafts and autosave', () => {
  it('loads a draft from the tree when a request is opened', async () => {
    await setup()
    expect(draft().name).toBe('Get users')
    expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
  })

  it('saves the draft once, 500 ms after the last change', async () => {
    const api = await setup()
    setUrl(REQUEST_PATH, 'http://a')
    expect(useApp.getState().saves[REQUEST_PATH]).toEqual({ state: 'saving' })
    await vi.advanceTimersByTimeAsync(300)
    setUrl(REQUEST_PATH, 'http://ab')
    await vi.advanceTimersByTimeAsync(499)
    expect(api.collections.saveRequest).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    expect(api.collections.saveRequest).toHaveBeenCalledWith(
      REQUEST_PATH,
      expect.objectContaining({ url: 'http://ab' }),
    )
    expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
  })

  it('serialises saves for one path and the last draft wins', async () => {
    const first = deferred<void>()
    const api = await setup()
    api.collections.saveRequest.mockReturnValueOnce(first.promise)
    setUrl(REQUEST_PATH, 'one')
    await vi.advanceTimersByTimeAsync(500)
    setUrl(REQUEST_PATH, 'two')
    await vi.advanceTimersByTimeAsync(500)
    setUrl(REQUEST_PATH, 'three')
    await vi.advanceTimersByTimeAsync(500)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    first.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(2)
    expect(api.collections.saveRequest).toHaveBeenLastCalledWith(
      REQUEST_PATH,
      expect.objectContaining({ url: 'three' }),
    )
    expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
  })

  it('keeps a draft edited during a save dirty after that save finishes', async () => {
    const first = deferred<void>()
    const api = await setup()
    api.collections.saveRequest.mockReturnValueOnce(first.promise)
    setUrl(REQUEST_PATH, 'one')
    await vi.advanceTimersByTimeAsync(500)
    setUrl(REQUEST_PATH, 'two')
    first.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(useApp.getState().saves[REQUEST_PATH]).toBeDefined()
    await vi.advanceTimersByTimeAsync(500)
    expect(api.collections.saveRequest).toHaveBeenLastCalledWith(REQUEST_PATH, expect.objectContaining({ url: 'two' }))
    expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
  })

  it('keeps the draft and stays dirty when a save fails, then retries on the next edit and on saveNow', async () => {
    const api = await setup()
    api.collections.saveRequest.mockRejectedValueOnce(new Error('disk full'))
    setUrl(REQUEST_PATH, 'one')
    await vi.advanceTimersByTimeAsync(500)
    expect(useApp.getState().saves[REQUEST_PATH]).toEqual({ state: 'failed', error: 'disk full' })
    expect(draft().url).toBe('one')
    expect(useApp.getState().error).toBeNull()

    api.collections.saveRequest.mockRejectedValueOnce(new Error('still full'))
    setUrl(REQUEST_PATH, 'two')
    expect(useApp.getState().saves[REQUEST_PATH]).toEqual({ state: 'saving' })
    await vi.advanceTimersByTimeAsync(500)
    expect(useApp.getState().saves[REQUEST_PATH]).toEqual({ state: 'failed', error: 'still full' })

    await useApp.getState().saveNow(REQUEST_PATH)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(3)
    expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
  })

  it('returns to the workspace gate when a save reports that the workspace is gone', async () => {
    const api = await setup()
    api.collections.saveRequest.mockRejectedValueOnce(new Error('workspace_unavailable: gone'))
    setUrl(REQUEST_PATH, 'one')
    await vi.advanceTimersByTimeAsync(500)
    expect(useApp.getState().workspace).toBeNull()
  })

  it('flushes a pending save when switching tabs', async () => {
    const api = await setup()
    useApp.getState().openRequest(OTHER_PATH)
    useApp.getState().openRequest(REQUEST_PATH)
    setUrl(REQUEST_PATH, 'one')
    useApp.getState().openRequest(OTHER_PATH)
    expect(api.collections.saveRequest).toHaveBeenCalledWith(REQUEST_PATH, expect.objectContaining({ url: 'one' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
  })

  it('flushes a pending save when closing a tab and drops the draft', async () => {
    const api = await setup()
    setUrl(REQUEST_PATH, 'one')
    useApp.getState().closeTab(REQUEST_PATH)
    expect(api.collections.saveRequest).toHaveBeenCalledWith(REQUEST_PATH, expect.objectContaining({ url: 'one' }))
    expect(useApp.getState().drafts[REQUEST_PATH]).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
  })

  it('reports a failed save of an already closed tab through the error banner', async () => {
    const api = await setup()
    api.collections.saveRequest.mockRejectedValueOnce(new Error('disk full'))
    setUrl(REQUEST_PATH, 'one')
    useApp.getState().closeTab(REQUEST_PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(useApp.getState().error).toBe('disk full')
  })

  it('flushes all pending saves for beforeunload', async () => {
    const api = await setup()
    useApp.getState().openRequest(OTHER_PATH)
    setUrl(REQUEST_PATH, 'one')
    setUrl(OTHER_PATH, 'two')
    useApp.getState().flushAllSaves()
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(2)
  })
})

describe('renames, moves and deletes', () => {
  const NEW_PATH = 'collections/shop/users/renamed.request.json'
  // What the main process would report after the rename and the save of the edit.
  const renamedTree = () => {
    const node = requestNode(NEW_PATH, 'Renamed')
    node.request = { ...node.request, url: 'one' }
    return treeWith(node, requestNode(OTHER_PATH, 'Other'))
  }

  it('never saves a pending draft to the old path while a rename is in flight', async () => {
    const rename = deferred<string>()
    const api = await setup({ collections: { rename: vi.fn().mockReturnValue(rename.promise) } })
    api.collections.list.mockResolvedValue(renamedTree())
    setUrl(REQUEST_PATH, 'one')
    const done = useApp.getState().rename(REQUEST_PATH, 'Renamed')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(api.collections.saveRequest).not.toHaveBeenCalled()
    rename.resolve(NEW_PATH)
    await done
    await vi.advanceTimersByTimeAsync(600)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    expect(api.collections.saveRequest).toHaveBeenCalledWith(NEW_PATH, expect.objectContaining({ url: 'one' }))
    expect(useApp.getState().drafts[REQUEST_PATH]).toBeUndefined()
    expect(draft(NEW_PATH).url).toBe('one')
    expect(useApp.getState().activePath).toBe(NEW_PATH)
  })

  it('remaps a pending save when the request is moved', async () => {
    const api = await setup({ collections: { move: vi.fn().mockResolvedValue(NEW_PATH) } })
    api.collections.list.mockResolvedValue(renamedTree())
    setUrl(REQUEST_PATH, 'one')
    await useApp.getState().move(REQUEST_PATH, 'collections/shop', 0)
    await vi.advanceTimersByTimeAsync(600)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    expect(api.collections.saveRequest).toHaveBeenCalledWith(NEW_PATH, expect.anything())
  })

  it('resumes saving to the old path when the rename fails', async () => {
    const api = await setup({ collections: { rename: vi.fn().mockRejectedValue(new Error('exists')) } })
    setUrl(REQUEST_PATH, 'one')
    await useApp.getState().rename(REQUEST_PATH, 'Renamed')
    await vi.advanceTimersByTimeAsync(600)
    expect(api.collections.saveRequest).toHaveBeenCalledWith(REQUEST_PATH, expect.objectContaining({ url: 'one' }))
  })

  it('waits for an in-flight save before renaming', async () => {
    const save = deferred<void>()
    const api = await setup({ collections: { saveRequest: vi.fn().mockReturnValue(save.promise) } })
    setUrl(REQUEST_PATH, 'one')
    await vi.advanceTimersByTimeAsync(500)
    const done = useApp.getState().rename(REQUEST_PATH, 'Renamed')
    await vi.advanceTimersByTimeAsync(0)
    expect(api.collections.rename).not.toHaveBeenCalled()
    save.resolve()
    await done
    expect(api.collections.rename).toHaveBeenCalled()
  })

  it('drops the draft and its pending save when the request is deleted', async () => {
    const api = await setup()
    setUrl(REQUEST_PATH, 'one')
    await useApp.getState().remove(REQUEST_PATH)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.collections.saveRequest).not.toHaveBeenCalled()
    expect(useApp.getState().drafts[REQUEST_PATH]).toBeUndefined()
    expect(useApp.getState().openTabs).toEqual([])
  })

  it('drops drafts of requests that vanished from the tree', async () => {
    const api = await setup()
    setUrl(REQUEST_PATH, 'one')
    api.collections.list.mockResolvedValue(treeWith(requestNode(OTHER_PATH, 'Other')))
    await useApp.getState().refresh()
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.collections.saveRequest).not.toHaveBeenCalled()
    expect(useApp.getState().drafts[REQUEST_PATH]).toBeUndefined()
  })
})

describe('external changes', () => {
  function changed(url: string) {
    const node = requestNode(REQUEST_PATH, 'Get users')
    node.request = { ...node.request, url }
    return treeWith(node, requestNode(OTHER_PATH, 'Other'))
  }

  it('updates a clean draft when a refresh brings a different saved version', async () => {
    const api = await setup()
    api.collections.list.mockResolvedValue(changed('http://external'))
    await useApp.getState().refresh()
    expect(draft().url).toBe('http://external')
  })

  it('keeps a dirty draft', async () => {
    const api = await setup()
    setUrl(REQUEST_PATH, 'mine')
    api.collections.list.mockResolvedValue(changed('http://external'))
    await useApp.getState().refresh()
    expect(draft().url).toBe('mine')
  })

  it('keeps a failed draft but adopts the name from disk', async () => {
    const api = await setup()
    api.collections.saveRequest.mockRejectedValue(new Error('x'))
    setUrl(REQUEST_PATH, 'mine')
    await vi.advanceTimersByTimeAsync(500)
    const node = requestNode(REQUEST_PATH, 'Renamed outside')
    api.collections.list.mockResolvedValue(treeWith(node))
    await useApp.getState().refresh()
    expect(draft().url).toBe('mine')
    expect(draft().name).toBe('Renamed outside')
  })
})

describe('send', () => {
  const OK: SendResult = {
    ok: true,
    response: {
      status: 200,
      statusText: 'OK',
      headers: [],
      bodyBase64: '',
      bodyTruncated: false,
      sizeBytes: 0,
      totalMs: 1,
      finalUrl: 'http://a',
      redirects: 0,
      cookies: [],
    },
  }

  it('sends the in-memory draft with the collection path and environment, and stores the result', async () => {
    const api = await setup({ http: { send: vi.fn().mockResolvedValue(OK) } })
    useApp.getState().setActiveEnvironment(null)
    setUrl(REQUEST_PATH, 'http://unsaved')
    const done = useApp.getState().send(REQUEST_PATH)
    expect(useApp.getState().responses[REQUEST_PATH]).toEqual({ state: 'sending' })
    await done
    expect(api.http.send).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://unsaved' }), {
      collectionPath: 'collections/shop',
      environmentId: null,
    })
    expect(useApp.getState().responses[REQUEST_PATH]).toEqual({ state: 'done', result: OK })
    // The pending save was flushed by sending.
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
  })

  it('passes the active environment id', async () => {
    const api = await setup({
      environments: {
        list: vi.fn().mockResolvedValue({ environments: [{ id: 'env1', name: 'Dev', variables: [] }], errors: [] }),
      },
      http: { send: vi.fn().mockResolvedValue(OK) },
    })
    await useApp.getState().refresh()
    useApp.getState().setActiveEnvironment('env1')
    await useApp.getState().send(REQUEST_PATH)
    expect(api.http.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ environmentId: 'env1' }))
  })

  it('does not start a second send while one is in flight, and cancel calls http.cancel', async () => {
    const pending = deferred<SendResult>()
    const api = await setup({ http: { send: vi.fn().mockReturnValue(pending.promise) } })
    const first = useApp.getState().send(REQUEST_PATH)
    await useApp.getState().send(REQUEST_PATH)
    expect(api.http.send).toHaveBeenCalledTimes(1)
    await useApp.getState().cancelSend()
    expect(api.http.cancel).toHaveBeenCalled()
    pending.resolve({ ok: false, error: { code: 'cancelled', message: 'Request cancelled' } })
    await first
    expect(useApp.getState().responses[REQUEST_PATH]?.state).toBe('done')
  })

  it('shows the error banner and stays idle when http.send rejects', async () => {
    await setup({ http: { send: vi.fn().mockRejectedValue(new Error('workspace_unavailable: gone')) } })
    await useApp.getState().send(REQUEST_PATH)
    expect(useApp.getState().responses[REQUEST_PATH]).toBeUndefined()
    expect(useApp.getState().error).toMatch(/workspace_unavailable/)
  })

  it('discards the result when the tab was closed meanwhile', async () => {
    const pending = deferred<SendResult>()
    await setup({ http: { send: vi.fn().mockReturnValue(pending.promise) } })
    const done = useApp.getState().send(REQUEST_PATH)
    useApp.getState().closeTab(REQUEST_PATH)
    pending.resolve(OK)
    await done
    expect(useApp.getState().responses[REQUEST_PATH]).toBeUndefined()
  })

  it('remaps the result when the request was renamed meanwhile', async () => {
    const pending = deferred<SendResult>()
    const NEW_PATH = 'collections/shop/users/renamed.request.json'
    const api = await setup({
      http: { send: vi.fn().mockReturnValue(pending.promise) },
      collections: { rename: vi.fn().mockResolvedValue(NEW_PATH) },
    })
    api.collections.list.mockResolvedValue(treeWith(requestNode(NEW_PATH, 'Renamed'), requestNode(OTHER_PATH, 'Other')))
    const done = useApp.getState().send(REQUEST_PATH)
    await useApp.getState().rename(REQUEST_PATH, 'Renamed')
    expect(useApp.getState().responses[NEW_PATH]).toEqual({ state: 'sending' })
    pending.resolve(OK)
    await done
    expect(useApp.getState().responses[NEW_PATH]).toEqual({ state: 'done', result: OK })
    expect(useApp.getState().responses[REQUEST_PATH]).toBeUndefined()
  })

  it('discards the result when the workspace changed meanwhile', async () => {
    const pending = deferred<SendResult>()
    await setup({ http: { send: vi.fn().mockReturnValue(pending.promise) } })
    const done = useApp.getState().send(REQUEST_PATH)
    await useApp.getState().openWorkspace('/tmp/other')
    pending.resolve(OK)
    await done
    expect(useApp.getState().responses).toEqual({})
  })
})
