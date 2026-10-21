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
    expect(screen.getByRole('button', { name: 'Method' })).toHaveTextContent('GET')
    expect(urlBar()).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Request name' })).toHaveValue('Get users')
    expect(screen.getByRole('region', { name: 'Response' })).toBeInTheDocument()
  })

  it('offers all seven methods in a custom dropdown, each in its colour', async () => {
    const { user } = await openedEditor()
    const button = screen.getByRole('button', { name: 'Method' })
    expect(button).toHaveClass('method-get')
    await user.click(button)
    const items = within(screen.getByRole('menu', { name: 'Method' })).getAllByRole('menuitemradio')
    expect(items.map((o) => o.textContent)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    expect(items[0]).toHaveAttribute('aria-checked', 'true')
    expect(items[4]).toHaveClass('method-delete')
    await user.click(items[4]!)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Method' })).toHaveClass('method-delete')
    expect(screen.getByRole('button', { name: 'Method' })).toHaveTextContent('DELETE')
    expect(useApp.getState().drafts[REQUEST_PATH]?.method).toBe('DELETE')
  })

  it('opens the method menu from the keyboard', async () => {
    const { user } = await openedEditor()
    screen.getByRole('button', { name: 'Method' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemradio', { name: 'GET' })).toHaveFocus()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(useApp.getState().drafts[REQUEST_PATH]?.method).toBe('POST')
  })

  it('applies the method colour to the select (the stylesheet cascade, not just the class)', async () => {
    const { user } = await openedEditor()
    const style = document.createElement('style')
    style.textContent = readFileSync('src/renderer/src/styles.css', 'utf8')
    document.head.appendChild(style)
    try {
      const colours: string[] = []
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        await user.click(screen.getByRole('button', { name: 'Method' }))
        await user.click(screen.getByRole('menuitemradio', { name: method }))
        const select = screen.getByRole('button', { name: 'Method' })
        const badge = document.createElement('span')
        badge.className = `method method-${method.toLowerCase()}`
        document.body.appendChild(badge)
        try {
          const expected = getComputedStyle(badge)
          const actual = getComputedStyle(select)
          // Every method has its own text colour; labels have no background.
          expect(expected.color).toContain(`--method-${method.toLowerCase()}`)
          expect(actual.color).toBe(expected.color)
          expect(actual.backgroundColor || actual.background).toMatch(/^(transparent|rgba\(0, 0, 0, 0\)|)$/)
          colours.push(actual.color)
        } finally {
          badge.remove()
        }
      }
      expect(new Set(colours).size).toBe(7)
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

  it('enables Save only while there are unsaved changes, and Save writes at once', async () => {
    const { api, user } = await openedEditor()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    typeUrl('http://a/now')
    expect(save).toBeEnabled()
    await user.click(save)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    expect(lastSaved(api)![1].url).toBe('http://a/now')
    await tick(0)
    expect(save).toBeDisabled()
    await tick(1000)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
  })

  it('saves with Cmd/Ctrl+S wherever the focus is', async () => {
    const { api } = await openedEditor()
    typeUrl('http://a/s')
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
  })

  it('saves with Cmd/Ctrl+S from an input that stops the key, and prevents the default', async () => {
    const { api } = await openedEditor()
    typeUrl('http://a/stop')
    const input = document.createElement('input')
    input.addEventListener('keydown', (e) => e.stopPropagation())
    document.body.appendChild(input)
    try {
      input.focus()
      const event = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    } finally {
      input.remove()
    }
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
    expect(screen.getByText('Query Params')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Param key 1' })).toHaveValue('q')
    expect(screen.getByRole('textbox', { name: 'Param value 1' })).toHaveValue('1')

    // The trailing empty row turns into a param as soon as something is typed in it.
    expect(screen.getByRole('textbox', { name: 'Param key 2' })).toHaveAttribute('placeholder', 'Key')
    await user.type(screen.getByRole('textbox', { name: 'Param key 2' }), 'z')
    expect(screen.getByRole('textbox', { name: 'Param key 2' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Param key 3' })).toHaveValue('')
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
    expect(screen.getByRole('columnheader', { name: /Description/ })).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Header key 1' }), 'X-Token')
    await user.type(screen.getByRole('textbox', { name: 'Header value 1' }), 'abc')
    await user.type(screen.getByRole('textbox', { name: 'Header description 1' }), 'auth')
    expect(screen.getByRole('tab', { name: /^Headers\s*\(1\)/ })).toBeInTheDocument()
    await tick(500)
    expect(lastSaved(api)![1].headers).toEqual([{ key: 'X-Token', value: 'abc', enabled: true, description: 'auth' }])
  })

  it('round-trips the rows through Bulk Edit, with // disabling a line', async () => {
    const { user } = await openedEditor()
    act(() =>
      useApp.getState().editDraft(REQUEST_PATH, (r) => ({
        ...r,
        headers: [
          { key: 'A', value: '1', enabled: true, description: 'kept' },
          { key: 'B', value: 'x:y', enabled: false },
        ],
      })),
    )
    await user.click(screen.getByRole('tab', { name: /^Headers/ }))
    await user.click(screen.getByRole('button', { name: 'Bulk Edit' }))
    const text = screen.getByRole('textbox', { name: 'Headers as key:value lines' })
    expect(text).toHaveValue('A:1\n//B:x:y')
    fireEvent.change(text, { target: { value: 'A:1\n//B:x:y\nC: 3' } })
    expect(useApp.getState().drafts[REQUEST_PATH]?.headers).toEqual([
      { key: 'A', value: '1', enabled: true, description: 'kept' },
      { key: 'B', value: 'x:y', enabled: false },
      { key: 'C', value: '3', enabled: true },
    ])
    await user.click(screen.getByRole('button', { name: 'Key-Value Edit' }))
    expect(screen.getByRole('textbox', { name: 'Header key 3' })).toHaveValue('C')
    expect(screen.getByRole('checkbox', { name: 'Header 2 enabled' })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Remove header 1' }))
    expect(useApp.getState().drafts[REQUEST_PATH]?.headers.map((h) => h.key)).toEqual(['B', 'C'])
  })

  describe('variables', () => {
    async function withVariables() {
      const ctx = await openedEditor({
        environments: {
          list: vi.fn().mockResolvedValue({
            environments: [
              {
                id: 'env1',
                name: 'Dev',
                variables: [
                  {
                    key: 'baseUrl',
                    value: 'http://shared',
                    currentValue: 'http://local',
                    secret: false,
                    enabled: true,
                  },
                  { key: 'token', value: '', currentValue: 'hunter2', secret: true, enabled: true },
                  { key: 'off', value: 'x', secret: false, enabled: false },
                ],
              },
              { id: 'globals', name: 'Globals', variables: [{ key: 'g', value: 'G', secret: false, enabled: true }] },
            ],
            errors: [],
          }),
        },
      })
      await act(() => useApp.getState().refresh())
      act(() => useApp.getState().setActiveEnvironment('env1'))
      return ctx
    }

    const token = (name: string) => document.querySelector(`.var-mirror [data-var="${name}"]`) as HTMLElement | null

    it('colours resolved and missing variables in the URL bar', async () => {
      await withVariables()
      typeUrl('{{baseUrl}}/x?a={{nope}}&b={{g}}&c={{off}}')
      expect(token('baseUrl')).toHaveClass('var-resolved')
      expect(token('g')).toHaveClass('var-resolved')
      expect(token('nope')).toHaveClass('var-missing')
      expect(token('off')).toHaveClass('var-missing')
      // The real input keeps the text; the mirror only paints it.
      expect(urlBar()).toHaveValue('{{baseUrl}}/x?a={{nope}}&b={{g}}&c={{off}}')
      expect(document.querySelector('.var-mirror')).toHaveAttribute('aria-hidden', 'true')
      act(() => useApp.getState().setActiveEnvironment(null))
      expect(token('baseUrl')).toHaveClass('var-missing')
    })

    it('shows the value and its source on hover, masking secrets', async () => {
      await withVariables()
      typeUrl('{{baseUrl}}/{{token}}/{{nope}}')
      const hoverOn = (name: string) => {
        const el = token(name)!
        el.getBoundingClientRect = () => new DOMRect(10, 10, 50, 16)
        fireEvent.mouseMove(urlBar(), { clientX: 20, clientY: 15 })
        const tip = screen.getByRole('tooltip')
        el.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
        return tip
      }
      const first = hoverOn('baseUrl')
      expect(first).toHaveTextContent('http://local')
      expect(first).toHaveTextContent('Environment · Dev')
      fireEvent.mouseLeave(urlBar())
      expect(screen.queryByRole('tooltip')).toBeNull()
      const secret = hoverOn('token')
      expect(secret).toHaveTextContent('••••')
      expect(secret).not.toHaveTextContent('hunter2')
      fireEvent.mouseLeave(urlBar())
      expect(hoverOn('nope')).toHaveTextContent('Unresolved')
    })
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
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://unsaved', id: `id-${REQUEST_PATH}` }),
      { collectionPath: 'collections/shop', environmentId: 'env1', requestPath: REQUEST_PATH },
      expect.any(String),
    )
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
    expect(api.http.cancel).toHaveBeenCalledWith(send.mock.calls[0][2])
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
    async function pick(user: ReturnType<typeof userEvent.setup>, menu: string, item: string) {
      await user.click(screen.getByRole('button', { name: menu }))
      await user.click(screen.getByRole('menuitemradio', { name: item }))
    }

    it('shows the code editor for raw JSON and keeps content across mode switches', async () => {
      const { api, user } = await openedEditor()
      await user.click(screen.getByRole('tab', { name: /^Body/ }))
      expect(screen.getByRole('button', { name: 'Body type' })).toHaveTextContent('none')
      expect(screen.getByText('This request does not have a body')).toBeInTheDocument()
      await pick(user, 'Body type', 'raw')
      const editor = screen.getByRole('textbox', { name: 'Body' })
      expect(editor).toHaveAttribute('data-language', 'text')
      expect(screen.queryByRole('button', { name: 'Beautify' })).toBeNull()
      await pick(user, 'Language', 'JSON')
      expect(screen.getByRole('textbox', { name: 'Body' })).toHaveAttribute('data-language', 'json')
      expect(screen.getByRole('tab', { name: /^Body\s*\(configured\)/ })).toBeInTheDocument()
      fireEvent.change(screen.getByRole('textbox', { name: 'Body' }), { target: { value: '{"a":1}' } })

      await pick(user, 'Body type', 'x-www-form-urlencoded')
      expect(screen.queryByRole('textbox', { name: 'Body' })).toBeNull()
      await user.type(screen.getByRole('textbox', { name: 'Field key 1' }), 'k')

      await pick(user, 'Body type', 'raw')
      expect(screen.getByRole('textbox', { name: 'Body' })).toHaveValue('{"a":1}')
      await pick(user, 'Body type', 'x-www-form-urlencoded')
      expect(screen.getByRole('textbox', { name: 'Field key 1' })).toHaveValue('k')

      await pick(user, 'Body type', 'none')
      await tick(500)
      expect(lastSaved(api)![1].body).toEqual({ mode: 'none' })
    })

    it('beautifies JSON and XML bodies', async () => {
      const { user } = await openedEditor()
      await user.click(screen.getByRole('tab', { name: /^Body/ }))
      await pick(user, 'Body type', 'raw')
      await pick(user, 'Language', 'JSON')
      fireEvent.change(screen.getByRole('textbox', { name: 'Body' }), { target: { value: '{"a":[1]}' } })
      await user.click(screen.getByRole('button', { name: 'Beautify' }))
      expect(screen.getByRole('textbox', { name: 'Body' })).toHaveValue('{\n  "a": [\n    1\n  ]\n}')
      await pick(user, 'Language', 'XML')
      fireEvent.change(screen.getByRole('textbox', { name: 'Body' }), { target: { value: '<a><b>x</b><c/></a>' } })
      await user.click(screen.getByRole('button', { name: 'Beautify' }))
      expect(screen.getByRole('textbox', { name: 'Body' })).toHaveValue('<a>\n  <b>x</b>\n  <c/>\n</a>')
    })

    it('states that form-data supports text fields only', async () => {
      const { user } = await openedEditor()
      await user.click(screen.getByRole('tab', { name: /^Body/ }))
      await pick(user, 'Body type', 'form-data')
      expect(screen.getByText(/text fields only/i)).toBeInTheDocument()
    })
  })

  describe('auth', () => {
    async function pick(user: ReturnType<typeof userEvent.setup>, menu: string, item: string) {
      await user.click(screen.getByRole('button', { name: menu }))
      await user.click(screen.getByRole('menuitemradio', { name: item }))
    }

    it('edits bearer, basic and api key credentials', async () => {
      const { api, user } = await openedEditor()
      await user.click(screen.getByRole('tab', { name: /^Authorization/ }))
      await user.click(screen.getByRole('button', { name: 'Auth type' }))
      expect(screen.getAllByRole('menuitemradio').map((o) => o.textContent)).toEqual([
        'Inherit from parent',
        'No auth',
        'Bearer token',
        'Basic auth',
        'API key',
      ])
      await user.click(screen.getByRole('menuitemradio', { name: 'Bearer token' }))
      await user.type(screen.getByRole('textbox', { name: 'Token' }), 't0k')
      expect(screen.getByRole('tab', { name: /^Authorization\s*\(configured\)/ })).toBeInTheDocument()
      await pick(user, 'Auth type', 'API key')
      await user.type(screen.getByRole('textbox', { name: 'Key' }), 'X-Key')
      await user.type(screen.getByRole('textbox', { name: 'Value' }), 'v')
      await pick(user, 'Add to', 'Query params')
      await tick(500)
      expect(lastSaved(api)![1].auth).toEqual({ type: 'apikey', key: 'X-Key', value: 'v', in: 'query' })
      await pick(user, 'Auth type', 'Bearer token')
      expect(screen.getByRole('textbox', { name: 'Token' })).toHaveValue('t0k')
      await pick(user, 'Auth type', 'Basic auth')
      await user.type(screen.getByRole('textbox', { name: 'Username' }), 'me')
      expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    })

    it('shows the inherited collection auth read-only, with the secret masked', async () => {
      const { user } = await openedEditor({
        collections: {
          list: vi.fn().mockResolvedValue({
            collections: [
              {
                ...collectionTree('collections/shop', 'Shop', [
                  folderNode('collections/shop/users', 'Users', [requestNode(REQUEST_PATH, 'Get users')]),
                ]),
                auth: { type: 'basic', username: '{{user}}', password: 'pw-secret' },
              },
            ],
            errors: [],
          }),
        },
      })
      await user.click(screen.getByRole('tab', { name: /^Authorization/ }))
      await pick(user, 'Auth type', 'Inherit from parent')
      expect(screen.getByText('Inherited')).toBeInTheDocument()
      expect(screen.getAllByText('Basic auth').length).toBeGreaterThan(0)
      expect(screen.getByRole('group', { name: 'Username' })).toHaveTextContent('{{user}}')
      expect(screen.getByRole('group', { name: 'Password' })).toHaveTextContent('••••')
      expect(screen.queryByText('pw-secret')).toBeNull()
      expect(screen.queryByRole('textbox', { name: 'Username' })).toBeNull()
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
        `rev:${REQUEST_PATH}`,
      )
      expect(screen.getAllByRole('tabpanel').length).toBeGreaterThan(0)
    })

    it('closes a clean tab directly', async () => {
      const { user } = await openedEditor()
      await user.click(screen.getByRole('button', { name: 'Close Get users' }))
      expect(useApp.getState().openTabs).toEqual([])
      expect(screen.getByText(/^Open a request from the sidebar/)).toBeInTheDocument()
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

    describe('changed on disk', () => {
      async function conflicted() {
        const ctx = await openedEditor()
        ctx.api.collections.saveRequest.mockRejectedValueOnce(new Error('changed_on_disk'))
        typeUrl('http://mine')
        await tick(500)
        return ctx
      }

      it('shows an inline bar with Overwrite and Reload from disk and keeps the draft', async () => {
        const { api } = await conflicted()
        const bar = screen.getByRole('alert', { name: 'Changed on disk' })
        expect(bar).toHaveTextContent('Changed on disk')
        expect(within(bar).getByRole('button', { name: 'Overwrite' })).toBeInTheDocument()
        expect(within(bar).getByRole('button', { name: 'Reload from disk' })).toBeInTheDocument()
        expect(screen.getByRole('status')).toHaveTextContent('Not saved: changed on disk')
        expect(urlBar()).toHaveValue('http://mine')
        typeUrl('http://mine2')
        await tick(2000)
        expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
      })

      it('Overwrite writes the draft without a revision and removes the bar', async () => {
        const { api, user } = await conflicted()
        await user.click(screen.getByRole('button', { name: 'Overwrite' }))
        await tick(0)
        expect(lastSaved(api)).toEqual([REQUEST_PATH, expect.objectContaining({ url: 'http://mine' }), undefined])
        expect(screen.queryByRole('alert', { name: 'Changed on disk' })).toBeNull()
        expect(screen.getByRole('status')).toHaveTextContent('Saved')
      })

      it('Reload from disk replaces the draft with the file on disk', async () => {
        const { api, user } = await conflicted()
        const node = requestNode(REQUEST_PATH, 'Get users')
        node.request = { ...node.request, url: 'http://resolved' }
        api.collections.list.mockResolvedValue({
          collections: [
            collectionTree('collections/shop', 'Shop', [folderNode('collections/shop/users', 'Users', [node])]),
          ],
          errors: [],
        })
        await user.click(screen.getByRole('button', { name: 'Reload from disk' }))
        await tick(0)
        expect(urlBar()).toHaveValue('http://resolved')
        expect(screen.queryByRole('alert', { name: 'Changed on disk' })).toBeNull()
        expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
      })

      it('asks before closing a tab in conflict', async () => {
        const { user } = await conflicted()
        await user.click(screen.getByRole('button', { name: 'Close Get users' }))
        expect(screen.getByRole('alertdialog')).toHaveTextContent('changed on disk')
      })
    })

    it('shows the collection path before the request name', async () => {
      await openedEditor()
      const crumbs = screen.getByRole('navigation', { name: 'Request location' })
      expect(crumbs).toHaveTextContent('ShopUsers')
    })

    it('renames through the title field', async () => {
      const { api, user } = await openedEditor()
      const title = screen.getByRole('textbox', { name: 'Request name' })
      await user.clear(title)
      await user.type(title, 'Fetch users{Enter}')
      expect(api.collections.rename).toHaveBeenCalledWith(REQUEST_PATH, 'Fetch users')
    })

    it('writes pending edits on a flush request from main, then acknowledges', async () => {
      let request: (() => void) | undefined
      const off = vi.fn()
      ;(window as unknown as { astralEvents: unknown }).astralEvents = {
        onFlushRequest: (listener: () => void) => {
          request = listener
          return off
        },
      }
      let finishSave!: (rev: string) => void
      const { api } = await openedEditor()
      api.collections.saveRequest.mockReturnValueOnce(new Promise<string>((r) => (finishSave = r)))
      typeUrl('http://typed-just-before-quit')
      request!()
      await tick(0)
      expect(api.collections.saveRequest).toHaveBeenCalledWith(
        REQUEST_PATH,
        expect.objectContaining({ url: 'http://typed-just-before-quit' }),
        `rev:${REQUEST_PATH}`,
      )
      expect(api.app.flushed).not.toHaveBeenCalled()
      await act(async () => finishSave('rev-2'))
      await tick(0)
      expect(api.app.flushed).toHaveBeenCalledTimes(1)
      cleanup()
      expect(off).toHaveBeenCalled()
      delete (window as unknown as { astralEvents?: unknown }).astralEvents
    })

    it('flushes pending saves when the window unloads', async () => {
      const { api } = await openedEditor()
      typeUrl('http://a')
      window.dispatchEvent(new Event('beforeunload'))
      expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    })
  })
})
