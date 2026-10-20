// @vitest-environment jsdom
/// <reference types="node" />
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { App } from '../../src/renderer/src/App'
import { initialState, useApp } from '../../src/renderer/src/state/store'
import type { SendResult } from '../../src/shared/types'
import { collectionTree, folderNode, installApi, REQUEST_PATH, requestNode, type MockApi } from './helpers'

// CodeMirror needs real layout; a textarea stands in for it here (tests/renderer/codeEditor.test.tsx covers the real one).
vi.mock('../../src/renderer/src/components/CodeEditor', () => ({
  CodeEditor: (p: { value: string; language: string; label?: string; onChange(v: string): void }) => (
    <textarea
      aria-label={p.label ?? 'code'}
      data-language={p.language}
      value={p.value}
      onChange={(e) => p.onChange(e.target.value)}
    />
  ),
}))

const OTHER_PATH = 'collections/shop/users/other.request.json'

beforeEach(() => {
  vi.useFakeTimers()
  // Testing Library only drives fake timers it recognises as Jest's; this lets it advance Vitest's.
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) })
  useApp.setState(initialState())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function openedEditor(overrides: Parameters<typeof installApi>[0] = {}) {
  const api = installApi({
    ...overrides,
    collections: {
      list: vi.fn().mockResolvedValue({
        collections: [
          collectionTree('collections/shop', 'Shop', [
            folderNode('collections/shop/users', 'Users', [
              requestNode(REQUEST_PATH, 'Get users'),
              requestNode(OTHER_PATH, 'Other', 'POST'),
            ]),
          ]),
        ],
        errors: [],
      }),
      ...overrides.collections,
    },
  })
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
  await useApp.getState().openWorkspace('/tmp/demo')
  useApp.getState().openRequest(REQUEST_PATH)
  render(<App />)
  return { api, user }
}

const urlBar = () => screen.getByRole('textbox', { name: 'URL' })
const typeUrl = (value: string) => fireEvent.change(urlBar(), { target: { value } })
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const lastSaved = (api: MockApi) => api.collections.saveRequest.mock.lastCall

describe('request editor', () => {
  it('shows the open request with its method, url and name', async () => {
    await openedEditor()
    expect(screen.getByRole('tab', { name: /Get users/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('combobox', { name: 'Method' })).toHaveValue('GET')
    expect(urlBar()).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Request name' })).toHaveValue('Get users')
    expect(screen.getByRole('region', { name: 'Response' })).toBeInTheDocument()
  })

  it('offers all seven methods and colours the select like the badge', async () => {
    const { user } = await openedEditor()
    const select = screen.getByRole('combobox', { name: 'Method' })
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    expect(select).toHaveClass('method-get')
    await user.selectOptions(select, 'DELETE')
    expect(select).toHaveClass('method-delete')
    expect(useApp.getState().drafts[REQUEST_PATH]?.method).toBe('DELETE')
  })

  it('applies the method colour to the select (the stylesheet cascade, not just the class)', async () => {
    const { user } = await openedEditor()
    const style = document.createElement('style')
    style.textContent = readFileSync('src/renderer/src/styles.css', 'utf8')
    document.head.appendChild(style)
    try {
      const select = screen.getByRole('combobox', { name: 'Method' })
      const colours: string[] = []
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        await user.selectOptions(select, method)
        const badge = document.createElement('span')
        badge.className = `method method-${method.toLowerCase()}`
        document.body.appendChild(badge)
        const expected = getComputedStyle(badge)
        const actual = getComputedStyle(select)
        expect(expected.color).toContain(`--m-${method.toLowerCase()}-fg`)
        expect(actual.color).toBe(expected.color)
        expect(actual.backgroundColor || actual.background).toBe(expected.backgroundColor || expected.background)
        colours.push(actual.color)
        badge.remove()
      }
      expect(new Set(colours).size).toBe(5)
    } finally {
      style.remove()
    }
  })

  it('autosaves once, 500 ms after the last URL edit, with url and params split', async () => {
    const { api } = await openedEditor()
    typeUrl('http://a/x')
    await tick(300)
    typeUrl('http://a/x?q=1 2&r=')
    await tick(499)
    expect(api.collections.saveRequest).not.toHaveBeenCalled()
    await tick(1)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    const [path, saved] = lastSaved(api)!
    expect(path).toBe(REQUEST_PATH)
    expect(saved.url).toBe('http://a/x')
    expect(saved.params).toEqual([
      { key: 'q', value: '1 2', enabled: true },
      { key: 'r', value: '', enabled: true },
    ])
    expect(screen.getByRole('status')).toHaveTextContent('Saved')
  })

  it('shows Saving while an edit is waiting and a failure message when the save fails', async () => {
    const { api } = await openedEditor()
    api.collections.saveRequest.mockRejectedValueOnce(new Error('disk full'))
    typeUrl('http://a')
    expect(screen.getByRole('status')).toHaveTextContent('Saving…')
    expect(screen.getByRole('tab', { name: /Get users/ })).toHaveTextContent('Unsaved changes')
    await tick(500)
    expect(screen.getByRole('status')).toHaveTextContent('Save failed: disk full')
  })

  it('keeps the params table and the URL bar in sync both ways', async () => {
    const { user } = await openedEditor()
    typeUrl('http://a/x?q=1')
    await user.click(screen.getByRole('tab', { name: /^Params/ }))
    expect(screen.getByRole('textbox', { name: 'Param key 1' })).toHaveValue('q')
    expect(screen.getByRole('textbox', { name: 'Param value 1' })).toHaveValue('1')

    await user.click(screen.getByRole('button', { name: 'Add param' }))
    await user.type(screen.getByRole('textbox', { name: 'Param key 2' }), 'z')
    await user.type(screen.getByRole('textbox', { name: 'Param value 2' }), 'a b')
    expect(urlBar()).toHaveValue('http://a/x?q=1&z=a%20b')

    await user.click(screen.getByRole('checkbox', { name: 'Param 1 enabled' }))
    expect(urlBar()).toHaveValue('http://a/x?z=a%20b')
    await user.click(screen.getByRole('button', { name: 'Remove param 2' }))
    expect(urlBar()).toHaveValue('http://a/x')
    // The disabled param survives in the table.
    expect(screen.getByRole('textbox', { name: 'Param key 1' })).toHaveValue('q')
  })

  it('never alters {{variables}} in the URL bar', async () => {
    await openedEditor()
    typeUrl('{{baseUrl}}/path?x={{y}}&b={{a b}}')
    expect(urlBar()).toHaveValue('{{baseUrl}}/path?x={{y}}&b={{a b}}')
    expect(useApp.getState().drafts[REQUEST_PATH]?.url).toBe('{{baseUrl}}/path')
  })

  it('adds a header row and saves it', async () => {
    const { api, user } = await openedEditor()
    await user.click(screen.getByRole('tab', { name: /^Headers/ }))
    await user.click(screen.getByRole('button', { name: 'Add header' }))
    await user.type(screen.getByRole('textbox', { name: 'Header key 1' }), 'X-Token')
    await user.type(screen.getByRole('textbox', { name: 'Header value 1' }), 'abc')
    await tick(500)
    expect(lastSaved(api)![1].headers).toEqual([{ key: 'X-Token', value: 'abc', enabled: true }])
    expect(screen.queryByText(/description/i)).toBeNull()
  })

  it('sends the unsaved draft with the collection path and the active environment', async () => {
    const result: SendResult = { ok: false, error: { code: 'x', message: 'y' } }
    const send = vi.fn().mockResolvedValue(result)
    const { api, user } = await openedEditor({
      http: { send },
      environments: {
        list: vi.fn().mockResolvedValue({ environments: [{ id: 'env1', name: 'Dev', variables: [] }], errors: [] }),
      },
    })
    await useApp.getState().refresh()
    useApp.getState().setActiveEnvironment('env1')
    typeUrl('http://unsaved')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://unsaved', id: `id-${REQUEST_PATH}` }), {
      collectionPath: 'collections/shop',
      environmentId: 'env1',
    })
    expect(useApp.getState().responses[REQUEST_PATH]?.state).toBe('done')
    expect(api.collections.saveRequest).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('turns Send into Cancel while in flight and cancels', async () => {
    let finish!: (r: SendResult) => void
    const send = vi.fn().mockReturnValue(new Promise<SendResult>((r) => (finish = r)))
    const { api, user } = await openedEditor({ http: { send } })
    await user.click(screen.getByRole('button', { name: 'Send' }))
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    await user.click(cancel)
    expect(api.http.cancel).toHaveBeenCalledTimes(1)
    await act(async () => finish({ ok: false, error: { code: 'cancelled', message: 'Request cancelled' } }))
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('sends with Ctrl+Enter and saves with Ctrl+S', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'y' } })
    const { api } = await openedEditor({ http: { send } })
    typeUrl('http://a')
    fireEvent.keyDown(urlBar(), { key: 'Enter', ctrlKey: true })
    expect(send).toHaveBeenCalledTimes(1)
    await tick(0)
    api.collections.saveRequest.mockClear()
    typeUrl('http://ab')
    fireEvent.keyDown(urlBar(), { key: 's', metaKey: true })
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
  })

  it('shows the error banner and stays idle when sending is rejected', async () => {
    const { user } = await openedEditor({
      http: { send: vi.fn().mockRejectedValue(new Error('workspace_unavailable: x')) },
    })
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(useApp.getState().responses[REQUEST_PATH]).toBeUndefined()
    expect(useApp.getState().error).toMatch(/workspace_unavailable/)
  })

  describe('body', () => {
    it('shows the code editor for raw JSON and keeps content across mode switches', async () => {
      const { api, user } = await openedEditor()
      await user.click(screen.getByRole('tab', { name: /^Body/ }))
      await user.click(screen.getByRole('radio', { name: 'Raw' }))
      const editor = screen.getByRole('textbox', { name: 'Body' })
      expect(editor).toHaveAttribute('data-language', 'text')
      await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'json')
      expect(screen.getByRole('textbox', { name: 'Body' })).toHaveAttribute('data-language', 'json')
      fireEvent.change(screen.getByRole('textbox', { name: 'Body' }), { target: { value: '{"a":1}' } })

      await user.click(screen.getByRole('radio', { name: 'x-www-form-urlencoded' }))
      expect(screen.queryByRole('textbox', { name: 'Body' })).toBeNull()
      await user.click(screen.getByRole('button', { name: 'Add field' }))
      await user.type(screen.getByRole('textbox', { name: 'Field key 1' }), 'k')

      await user.click(screen.getByRole('radio', { name: 'Raw' }))
      expect(screen.getByRole('textbox', { name: 'Body' })).toHaveValue('{"a":1}')
      await user.click(screen.getByRole('radio', { name: 'x-www-form-urlencoded' }))
      expect(screen.getByRole('textbox', { name: 'Field key 1' })).toHaveValue('k')

      await user.click(screen.getByRole('radio', { name: 'None' }))
      await tick(500)
      expect(lastSaved(api)![1].body).toEqual({ mode: 'none' })
    })

    it('states that form-data supports text fields only', async () => {
      const { user } = await openedEditor()
      await user.click(screen.getByRole('tab', { name: /^Body/ }))
      await user.click(screen.getByRole('radio', { name: 'form-data' }))
      expect(screen.getByText(/text fields only/i)).toBeInTheDocument()
    })
  })

  describe('auth', () => {
    it('edits bearer, basic and api key credentials', async () => {
      const { api, user } = await openedEditor()
      await user.click(screen.getByRole('tab', { name: /^Auth/ }))
      const type = screen.getByRole('combobox', { name: 'Auth type' })
      expect(
        within(type)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Inherit from parent', 'No auth', 'Bearer token', 'Basic auth', 'API key'])
      await user.selectOptions(type, 'bearer')
      await user.type(screen.getByRole('textbox', { name: 'Token' }), 't0k')
      await user.selectOptions(type, 'apikey')
      await user.type(screen.getByRole('textbox', { name: 'Key' }), 'X-Key')
      await user.type(screen.getByRole('textbox', { name: 'Value' }), 'v')
      await user.selectOptions(screen.getByRole('combobox', { name: 'Add to' }), 'query')
      await tick(500)
      expect(lastSaved(api)![1].auth).toEqual({ type: 'apikey', key: 'X-Key', value: 'v', in: 'query' })
      await user.selectOptions(type, 'bearer')
      expect(screen.getByRole('textbox', { name: 'Token' })).toHaveValue('t0k')
      await user.selectOptions(type, 'basic')
      await user.type(screen.getByRole('textbox', { name: 'Username' }), 'me')
      expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    })
  })

  describe('tabs and name', () => {
    it('switches tabs with the keyboard and flushes the pending save of the tab left', async () => {
      const { api, user } = await openedEditor()
      useApp.getState().openRequest(OTHER_PATH)
      useApp.getState().openRequest(REQUEST_PATH)
      await tick(0)
      typeUrl('http://a')
      const first = screen.getByRole('tab', { name: /Get users/ })
      first.focus()
      await user.keyboard('{ArrowRight}')
      expect(useApp.getState().activePath).toBe(OTHER_PATH)
      expect(api.collections.saveRequest).toHaveBeenCalledWith(
        REQUEST_PATH,
        expect.objectContaining({ url: 'http://a' }),
      )
      expect(screen.getAllByRole('tabpanel').length).toBeGreaterThan(0)
    })

    it('closes a clean tab directly', async () => {
      const { user } = await openedEditor()
      await user.click(screen.getByRole('button', { name: 'Close Get users' }))
      expect(useApp.getState().openTabs).toEqual([])
      expect(screen.getByText('Open a request')).toBeInTheDocument()
    })

    it('asks before closing a tab whose save failed', async () => {
      const { api, user } = await openedEditor()
      api.collections.saveRequest.mockRejectedValue(new Error('disk full'))
      typeUrl('http://a')
      await tick(500)
      await user.click(screen.getByRole('button', { name: 'Close Get users' }))
      const dialog = screen.getByRole('alertdialog')
      expect(dialog).toHaveTextContent('could not be saved')
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      expect(useApp.getState().openTabs).toHaveLength(1)
      await user.click(screen.getByRole('button', { name: 'Close Get users' }))
      await user.click(screen.getByRole('button', { name: 'Close and discard' }))
      expect(useApp.getState().openTabs).toEqual([])
    })

    it('renames through the title field', async () => {
      const { api, user } = await openedEditor()
      const title = screen.getByRole('textbox', { name: 'Request name' })
      await user.clear(title)
      await user.type(title, 'Fetch users{Enter}')
      expect(api.collections.rename).toHaveBeenCalledWith(REQUEST_PATH, 'Fetch users')
    })

    it('flushes pending saves when the window unloads', async () => {
      const { api } = await openedEditor()
      typeUrl('http://a')
      window.dispatchEvent(new Event('beforeunload'))
      expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    })
  })
})
