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
      `rev:${REQUEST_PATH}`,
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
    // The mocked first save resolved without a revision.
    expect(api.collections.saveRequest).toHaveBeenLastCalledWith(
      REQUEST_PATH,
      expect.objectContaining({ url: 'three' }),
      undefined,
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
    expect(api.collections.saveRequest).toHaveBeenLastCalledWith(
      REQUEST_PATH,
      expect.objectContaining({ url: 'two' }),
      undefined,
    )
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
    expect(api.collections.saveRequest).toHaveBeenCalledWith(
      REQUEST_PATH,
      expect.objectContaining({ url: 'one' }),
      `rev:${REQUEST_PATH}`,
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
  })

  it('flushes a pending save when closing a tab and drops the draft', async () => {
    const api = await setup()
    setUrl(REQUEST_PATH, 'one')
    useApp.getState().closeTab(REQUEST_PATH)
    expect(api.collections.saveRequest).toHaveBeenCalledWith(
      REQUEST_PATH,
      expect.objectContaining({ url: 'one' }),
      `rev:${REQUEST_PATH}`,
    )
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
    expect(useApp.getState().error).toContain('disk full')
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
    expect(api.collections.saveRequest).toHaveBeenCalledWith(
      NEW_PATH,
      expect.objectContaining({ url: 'one' }),
      `rev:${NEW_PATH}`,
    )
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
    expect(api.collections.saveRequest).toHaveBeenCalledWith(NEW_PATH, expect.anything(), `rev:${NEW_PATH}`)
  })

  it('resumes saving to the old path when the rename fails', async () => {
    const api = await setup({ collections: { rename: vi.fn().mockRejectedValue(new Error('exists')) } })
    setUrl(REQUEST_PATH, 'one')
    await useApp.getState().rename(REQUEST_PATH, 'Renamed')
    await vi.advanceTimersByTimeAsync(600)
    expect(api.collections.saveRequest).toHaveBeenCalledWith(
      REQUEST_PATH,
      expect.objectContaining({ url: 'one' }),
      `rev:${REQUEST_PATH}`,
    )
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

describe('changed on disk (revisions)', () => {
  const REV = `rev:${REQUEST_PATH}`
  function external(url: string, revision: string) {
    const node = requestNode(REQUEST_PATH, 'Get users')
    node.request = { ...node.request, url }
    node.revision = revision
    return treeWith(node, requestNode(OTHER_PATH, 'Other'))
  }
  const changedOnDisk = () => Promise.reject(new Error('changed_on_disk'))

  it('sends the revision from the tree, then the one returned by each save', async () => {
    const api = await setup()
    api.collections.saveRequest.mockResolvedValueOnce('rev-2').mockResolvedValueOnce('rev-3')
    // The refresh after a save lists what is on disk now.
    api.collections.list.mockResolvedValue(external('one', 'rev-2'))
    setUrl(REQUEST_PATH, 'one')
    await vi.advanceTimersByTimeAsync(500)
    expect(api.collections.saveRequest).toHaveBeenLastCalledWith(REQUEST_PATH, expect.anything(), REV)
    setUrl(REQUEST_PATH, 'two')
    await vi.advanceTimersByTimeAsync(500)
    expect(api.collections.saveRequest).toHaveBeenLastCalledWith(REQUEST_PATH, expect.anything(), 'rev-2')
  })

  it('adopts the revision of a clean draft that follows an external change', async () => {
    const api = await setup()
    api.collections.list.mockResolvedValue(external('http://external', 'rev-ext'))
    await useApp.getState().refresh()
    setUrl(REQUEST_PATH, 'mine')
    await vi.advanceTimersByTimeAsync(500)
    expect(api.collections.saveRequest).toHaveBeenLastCalledWith(
      REQUEST_PATH,
      expect.objectContaining({ url: 'mine' }),
      'rev-ext',
    )
  })

  it('keeps the old revision for a dirty draft, so its save reports the conflict and keeps the draft', async () => {
    const api = await setup()
    api.collections.saveRequest.mockImplementation((_p: string, _r: RequestItem, rev?: string) =>
      rev === REV ? changedOnDisk() : Promise.resolve('rev-x'),
    )
    setUrl(REQUEST_PATH, 'mine')
    api.collections.list.mockResolvedValue(external('http://external', 'rev-ext'))
    await useApp.getState().refresh()
    await vi.advanceTimersByTimeAsync(500)
    expect(api.collections.saveRequest).toHaveBeenCalledWith(REQUEST_PATH, expect.anything(), REV)
    expect(useApp.getState().saves[REQUEST_PATH]).toEqual({ state: 'conflict' })
    expect(draft().url).toBe('mine')
    expect(useApp.getState().error).toBeNull()
  })

  it('does not autosave, flush or saveNow while in conflict; edits stay in the draft', async () => {
    const api = await setup()
    api.collections.saveRequest.mockImplementationOnce(changedOnDisk)
    setUrl(REQUEST_PATH, 'mine')
    await vi.advanceTimersByTimeAsync(500)
    expect(useApp.getState().saves[REQUEST_PATH]).toEqual({ state: 'conflict' })
    setUrl(REQUEST_PATH, 'mine 2')
    expect(useApp.getState().saves[REQUEST_PATH]).toEqual({ state: 'conflict' })
    await vi.advanceTimersByTimeAsync(2000)
    useApp.getState().flushSave(REQUEST_PATH)
    useApp.getState().flushAllSaves()
    await useApp.getState().saveNow(REQUEST_PATH)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    expect(draft().url).toBe('mine 2')
  })

  it('Overwrite saves the draft without a revision and clears the conflict', async () => {
    const api = await setup()
    api.collections.saveRequest.mockImplementationOnce(changedOnDisk).mockResolvedValueOnce('rev-over')
    setUrl(REQUEST_PATH, 'mine')
    await vi.advanceTimersByTimeAsync(500)
    await useApp.getState().overwriteOnDisk(REQUEST_PATH)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(2)
    expect(api.collections.saveRequest.mock.calls[1]).toEqual([
      REQUEST_PATH,
      expect.objectContaining({ url: 'mine' }),
      undefined,
    ])
    expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
    // Later saves are checked against the overwritten revision again.
    api.collections.list.mockResolvedValue(external('mine', 'rev-over'))
    await useApp.getState().refresh()
    setUrl(REQUEST_PATH, 'after')
    await vi.advanceTimersByTimeAsync(500)
    expect(api.collections.saveRequest).toHaveBeenLastCalledWith(REQUEST_PATH, expect.anything(), 'rev-over')
  })

  it('Reload from disk discards the draft and adopts the file on disk and its revision', async () => {
    const api = await setup()
    api.collections.saveRequest.mockImplementationOnce(changedOnDisk)
    setUrl(REQUEST_PATH, 'mine')
    await vi.advanceTimersByTimeAsync(500)
    api.collections.list.mockResolvedValue(external('http://resolved', 'rev-resolved'))
    await useApp.getState().reloadFromDisk(REQUEST_PATH)
    expect(draft().url).toBe('http://resolved')
    expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    setUrl(REQUEST_PATH, 'next')
    await vi.advanceTimersByTimeAsync(500)
    expect(api.collections.saveRequest).toHaveBeenLastCalledWith(REQUEST_PATH, expect.anything(), 'rev-resolved')
  })

  it('does not report a false conflict for an edit pending across a rename of the request', async () => {
    const NEW_PATH = 'collections/shop/users/renamed.request.json'
    const api = await setup({ collections: { rename: vi.fn().mockResolvedValue(NEW_PATH) } })
    const node = requestNode(NEW_PATH, 'Renamed')
    node.revision = 'rev-after-rename'
    api.collections.list.mockResolvedValue(treeWith(node, requestNode(OTHER_PATH, 'Other')))
    setUrl(REQUEST_PATH, 'one')
    await useApp.getState().rename(REQUEST_PATH, 'Renamed')
    await vi.advanceTimersByTimeAsync(600)
    expect(api.collections.saveRequest).toHaveBeenCalledWith(NEW_PATH, expect.anything(), 'rev-after-rename')
  })

  it('keeps the conflict of a closed tab: an error is shown and reopening shows the conflict', async () => {
    const api = await setup()
    api.collections.saveRequest.mockImplementationOnce(changedOnDisk)
    setUrl(REQUEST_PATH, 'mine')
    useApp.getState().closeTab(REQUEST_PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(useApp.getState().error).toBe(`Could not save ${REQUEST_PATH}: it was changed on disk`)
    useApp.getState().openRequest(REQUEST_PATH)
    expect(draft().url).toBe('mine')
    expect(useApp.getState().saves[REQUEST_PATH]).toEqual({ state: 'conflict' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
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
    expect(api.http.send).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://unsaved' }),
      { collectionPath: 'collections/shop', environmentId: null },
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    )
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
    expect(api.http.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ environmentId: 'env1' }),
      expect.any(String),
    )
  })

  it('does not start a second send while one is in flight, and cancel cancels that send by its id', async () => {
    const pending = deferred<SendResult>()
    const api = await setup({ http: { send: vi.fn().mockReturnValue(pending.promise) } })
    const first = useApp.getState().send(REQUEST_PATH)
    await useApp.getState().send(REQUEST_PATH)
    expect(api.http.send).toHaveBeenCalledTimes(1)
    await useApp.getState().cancelSend(REQUEST_PATH)
    expect(api.http.cancel).toHaveBeenCalledWith(api.http.send.mock.calls[0][2])
    pending.resolve({ ok: false, error: { code: 'cancelled', message: 'Request cancelled' } })
    await first
    expect(useApp.getState().responses[REQUEST_PATH]?.state).toBe('done')
  })

  it('keeps sends of two tabs independent: each completes on its own and Cancel only targets its tab', async () => {
    const a = deferred<SendResult>()
    const b = deferred<SendResult>()
    const api = await setup({ http: { send: vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise) } })
    useApp.getState().openRequest(OTHER_PATH)
    const sendA = useApp.getState().send(REQUEST_PATH)
    const sendB = useApp.getState().send(OTHER_PATH)
    const [idA, idB] = api.http.send.mock.calls.map((c) => c[2] as string)
    expect(idA).not.toBe(idB)

    await useApp.getState().cancelSend(OTHER_PATH)
    expect(api.http.cancel).toHaveBeenCalledTimes(1)
    expect(api.http.cancel).toHaveBeenCalledWith(idB)

    a.resolve(OK)
    await sendA
    expect(useApp.getState().responses[REQUEST_PATH]).toEqual({ state: 'done', result: OK })
    expect(useApp.getState().responses[OTHER_PATH]).toEqual({ state: 'sending' })
    const cancelled: SendResult = { ok: false, error: { code: 'cancelled', message: 'Request cancelled' } }
    b.resolve(cancelled)
    await sendB
    expect(useApp.getState().responses[OTHER_PATH]).toEqual({ state: 'done', result: cancelled })
  })

  it('does nothing when cancelling a tab with no send in flight', async () => {
    const api = await setup()
    await useApp.getState().cancelSend(REQUEST_PATH)
    expect(api.http.cancel).not.toHaveBeenCalled()
  })

  it('cancels by the same id after the request was renamed', async () => {
    const pending = deferred<SendResult>()
    const NEW_PATH = 'collections/shop/users/renamed.request.json'
    const api = await setup({
      http: { send: vi.fn().mockReturnValue(pending.promise) },
      collections: { rename: vi.fn().mockResolvedValue(NEW_PATH) },
    })
    api.collections.list.mockResolvedValue(treeWith(requestNode(NEW_PATH, 'Renamed'), requestNode(OTHER_PATH, 'Other')))
    const done = useApp.getState().send(REQUEST_PATH)
    await useApp.getState().rename(REQUEST_PATH, 'Renamed')
    await useApp.getState().cancelSend(NEW_PATH)
    expect(api.http.cancel).toHaveBeenCalledWith(api.http.send.mock.calls[0][2])
    pending.resolve(OK)
    await done
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

describe('closed tabs with a save still pending or in flight', () => {
  const FOLDER = 'collections/shop/users'
  const NEW_FOLDER = 'collections/shop/people'
  // A mocked disk: saves land in `disk`, the tree is always read from it.
  async function setupDisk(overrides: Parameters<typeof installApi>[0] = {}) {
    const disk = new Map<string, RequestItem>([[REQUEST_PATH, requestNode(REQUEST_PATH, 'Get users').request]])
    const tree = () => {
      const node = (p: string) => {
        const n = requestNode(p, 'Get users')
        return { ...n, request: disk.get(p)! }
      }
      return treeWith(...[...disk.keys()].map(node))
    }
    const api = await setup({
      ...overrides,
      collections: { list: vi.fn().mockImplementation(async () => tree()), ...overrides.collections },
    })
    return { api, disk }
  }

  it('keeps an edit closed within the debounce window: reopening shows it and the disk ends with it', async () => {
    const { api, disk } = await setupDisk()
    api.collections.saveRequest.mockImplementation(async (p: string, r: RequestItem) => void disk.set(p, r))
    setUrl(REQUEST_PATH, 'one')
    useApp.getState().closeTab(REQUEST_PATH)
    useApp.getState().openRequest(REQUEST_PATH)
    expect(draft().url).toBe('one')
    await vi.advanceTimersByTimeAsync(10)
    expect(disk.get(REQUEST_PATH)?.url).toBe('one')
    expect(draft().url).toBe('one')
    setUrl(REQUEST_PATH, 'two')
    await vi.advanceTimersByTimeAsync(600)
    expect(disk.get(REQUEST_PATH)?.url).toBe('two')
  })

  it('refreshes the tree after a closed tab saved, so a reopened tab starts from the saved copy', async () => {
    const { api, disk } = await setupDisk()
    api.collections.saveRequest.mockImplementation(async (p: string, r: RequestItem) => void disk.set(p, r))
    setUrl(REQUEST_PATH, 'one')
    useApp.getState().closeTab(REQUEST_PATH)
    await vi.advanceTimersByTimeAsync(10)
    useApp.getState().openRequest(REQUEST_PATH)
    expect(draft().url).toBe('one')
  })

  it('serialises saves across a close and reopen while one is in flight; the last edit wins', async () => {
    const first = deferred<void>()
    const { api, disk } = await setupDisk()
    const order: string[] = []
    api.collections.saveRequest.mockImplementation(async (p: string, r: RequestItem) => {
      order.push(`start ${r.url}`)
      if (r.url === 'one') await first.promise
      disk.set(p, r)
      order.push(`end ${r.url}`)
    })
    setUrl(REQUEST_PATH, 'one')
    await vi.advanceTimersByTimeAsync(500)
    useApp.getState().closeTab(REQUEST_PATH)
    useApp.getState().openRequest(REQUEST_PATH)
    expect(draft().url).toBe('one')
    setUrl(REQUEST_PATH, 'two')
    await vi.advanceTimersByTimeAsync(600)
    expect(order).toEqual(['start one'])
    first.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(order).toEqual(['start one', 'end one', 'start two', 'end two'])
    expect(disk.get(REQUEST_PATH)?.url).toBe('two')
    expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
  })

  it('makes a folder rename wait for a closed tab save and writes nothing to the old path afterwards', async () => {
    const first = deferred<void>()
    const rename = vi.fn().mockResolvedValue(NEW_FOLDER)
    const { api, disk } = await setupDisk({ collections: { rename } })
    api.collections.saveRequest.mockImplementation(async (p: string, r: RequestItem) => {
      await first.promise
      disk.set(p, r)
    })
    rename.mockImplementation(async () => {
      const r = disk.get(REQUEST_PATH)!
      disk.delete(REQUEST_PATH)
      disk.set(`${NEW_FOLDER}/get-users.request.json`, r)
      return NEW_FOLDER
    })
    setUrl(REQUEST_PATH, 'one')
    await vi.advanceTimersByTimeAsync(500)
    useApp.getState().closeTab(REQUEST_PATH)
    const done = useApp.getState().rename(FOLDER, 'People')
    await vi.advanceTimersByTimeAsync(10)
    expect(rename).not.toHaveBeenCalled()
    first.resolve()
    await done
    await vi.advanceTimersByTimeAsync(1000)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    expect(disk.has(REQUEST_PATH)).toBe(false)
    expect(disk.get(`${NEW_FOLDER}/get-users.request.json`)?.url).toBe('one')
  })

  it('does not leave a closed tab stuck at "saving": a reopened clean tab follows external changes', async () => {
    const first = deferred<void>()
    const { api, disk } = await setupDisk()
    api.collections.saveRequest.mockImplementation(async (p: string, r: RequestItem) => void disk.set(p, r))
    api.collections.saveRequest.mockImplementationOnce(async (p: string, r: RequestItem) => {
      await first.promise
      disk.set(p, r)
    })
    setUrl(REQUEST_PATH, 'one')
    await vi.advanceTimersByTimeAsync(500)
    setUrl(REQUEST_PATH, 'two')
    useApp.getState().closeTab(REQUEST_PATH)
    first.resolve()
    await vi.advanceTimersByTimeAsync(50)
    expect(disk.get(REQUEST_PATH)?.url).toBe('two')
    useApp.getState().openRequest(REQUEST_PATH)
    expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
    disk.set(REQUEST_PATH, { ...disk.get(REQUEST_PATH)!, url: 'external' })
    await useApp.getState().refresh()
    expect(draft().url).toBe('external')
  })

  describe('a closed tab whose save failed', () => {
    async function failedClose() {
      const first = deferred<void>()
      const ctx = await setupDisk({ collections: { remove: vi.fn() } })
      ctx.api.collections.saveRequest.mockImplementation(async (p: string, r: RequestItem) => void ctx.disk.set(p, r))
      ctx.api.collections.saveRequest.mockReturnValueOnce(first.promise)
      ctx.api.collections.remove.mockImplementation(async (p: string) => void ctx.disk.delete(p))
      setUrl(REQUEST_PATH, 'one')
      await vi.advanceTimersByTimeAsync(500)
      useApp.getState().closeTab(REQUEST_PATH)
      first.reject(new Error('disk full'))
      await vi.advanceTimersByTimeAsync(50)
      return ctx
    }

    it('keeps the draft: reopening shows it as failed, and a save retry succeeds', async () => {
      const { api, disk } = await failedClose()
      expect(useApp.getState().error).toContain(REQUEST_PATH)
      expect(useApp.getState().error).toContain('disk full')
      useApp.getState().openRequest(REQUEST_PATH)
      expect(draft().url).toBe('one')
      expect(useApp.getState().saves[REQUEST_PATH]).toEqual({ state: 'failed', error: 'disk full' })
      await useApp.getState().saveNow(REQUEST_PATH)
      expect(api.collections.saveRequest).toHaveBeenCalledTimes(2)
      expect(disk.get(REQUEST_PATH)?.url).toBe('one')
      expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
    })

    it('is dropped without saving when the request is deleted', async () => {
      const { api } = await failedClose()
      await useApp.getState().remove(REQUEST_PATH)
      useApp.getState().openRequest(REQUEST_PATH)
      expect(useApp.getState().drafts[REQUEST_PATH]).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    })
  })

  it('revives the draft when reopened while the refresh after a closed save has not applied yet', async () => {
    const gate = deferred<ReturnType<typeof treeWith>>()
    const { api, disk } = await setupDisk()
    api.collections.saveRequest.mockImplementation(async (p: string, r: RequestItem) => void disk.set(p, r))
    api.collections.list.mockImplementationOnce(() => gate.promise)
    setUrl(REQUEST_PATH, 'one')
    useApp.getState().closeTab(REQUEST_PATH)
    await vi.advanceTimersByTimeAsync(10)
    useApp.getState().openRequest(REQUEST_PATH)
    expect(draft().url).toBe('one')
    const saved = requestNode(REQUEST_PATH, 'Get users')
    gate.resolve(treeWith({ ...saved, request: disk.get(REQUEST_PATH)! }))
    await vi.advanceTimersByTimeAsync(50)
    expect(draft().url).toBe('one')
    expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
  })

  it('releases a failed closed entry when a chained later save succeeds', async () => {
    const first = deferred<void>()
    const { api, disk } = await setupDisk()
    api.collections.saveRequest.mockImplementation(async (p: string, r: RequestItem) => void disk.set(p, r))
    api.collections.saveRequest.mockReturnValueOnce(first.promise)
    setUrl(REQUEST_PATH, 'one')
    await vi.advanceTimersByTimeAsync(500)
    setUrl(REQUEST_PATH, 'two')
    useApp.getState().closeTab(REQUEST_PATH)
    first.reject(new Error('disk full'))
    await vi.advanceTimersByTimeAsync(50)
    expect(disk.get(REQUEST_PATH)?.url).toBe('two')
    useApp.getState().openRequest(REQUEST_PATH)
    expect(useApp.getState().saves[REQUEST_PATH]).toBeUndefined()
    disk.set(REQUEST_PATH, { ...disk.get(REQUEST_PATH)!, url: 'external' })
    await useApp.getState().refresh()
    expect(draft().url).toBe('external')
  })
})
