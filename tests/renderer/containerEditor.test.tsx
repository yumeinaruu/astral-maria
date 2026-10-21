// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { AUTOSAVE_DELAY_MS, initialState, useApp } from '../../src/renderer/src/state/store'
import type { CollectionTree } from '../../src/shared/types'
import { collectionTree, FOLDER_PATH, folderNode, installApi, REQUEST_PATH, requestNode, type MockApi } from './helpers'

// CodeMirror needs real layout; a textarea stands in for it here (tests/renderer/codeEditor.test.tsx covers the real one).
vi.mock('../../src/renderer/src/components/CodeEditor', () => ({
  CodeEditor: (p: { value: string; label?: string; onChange(v: string): void }) => (
    <textarea aria-label={p.label ?? 'code'} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
}))

const SHOP = 'collections/shop'

function tree(): CollectionTree[] {
  const shop = collectionTree(SHOP, 'Shop', [
    folderNode(FOLDER_PATH, 'Users', [requestNode(REQUEST_PATH, 'Get users')]),
  ])
  shop.variables = [{ key: 'baseUrl', value: 'https://api.example.com', enabled: true }]
  return [shop]
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) })
  useApp.setState(initialState())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function mounted(collections = tree()): Promise<MockApi> {
  const api = installApi({ collections: { list: vi.fn().mockResolvedValue({ collections, errors: [] }) } })
  await useApp.getState().openWorkspace('/tmp/demo')
  useApp.getState().setExpanded(FOLDER_PATH, true)
  render(<App />)
  return api
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const row = (name: string) => screen.getByRole('treeitem', { name })
const tabNames = () =>
  within(screen.getByRole('tablist', { name: 'Open tabs' }))
    .queryAllByRole('tab')
    .map((t) => t.textContent)

function editFromMenu(name: string): void {
  fireEvent.contextMenu(row(name))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
}

function openSection(name: string): void {
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }))
}

describe('collection and folder settings tab', () => {
  it('opens a collection from the Edit menu item, with Authorization, Scripts and Variables', async () => {
    await mounted()
    editFromMenu('Shop')
    expect(useApp.getState().activePath).toBe(SHOP)
    expect(tabNames()).toEqual(['Shop'])
    const sections = within(screen.getByRole('tablist', { name: 'Collection sections' })).getAllByRole('tab')
    expect(sections.map((t) => t.textContent)).toEqual(['Authorization', 'Scripts', 'Variables (1)'])
  })

  it('opens a folder with Enter, while a click only expands or collapses it', async () => {
    await mounted()
    fireEvent.click(row('Users'))
    expect(useApp.getState().openTabs).toEqual([])
    expect(screen.queryByRole('treeitem', { name: 'Get users' })).toBeNull()
    const treeEl = screen.getByRole('tree')
    treeEl.focus()
    fireEvent.keyDown(treeEl, { key: 'Enter' })
    expect(useApp.getState().activePath).toBe(FOLDER_PATH)
    expect(tabNames()).toEqual(['Users'])
  })

  it('shows only Scripts on a folder, with a note about authorization', async () => {
    await mounted()
    editFromMenu('Users')
    const sections = within(screen.getByRole('tablist', { name: 'Folder sections' })).getAllByRole('tab')
    expect(sections.map((t) => t.textContent)).toEqual(['Scripts'])
    expect(screen.getByText('Folder authorization is inherited from the collection')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Auth type' })).toBeNull()
  })

  it('autosaves edited folder scripts with a scripts-only patch', async () => {
    const api = await mounted()
    editFromMenu('Users')
    fireEvent.change(screen.getByRole('textbox', { name: 'Pre-request script' }), { target: { value: 'let a = 1' } })
    expect(useApp.getState().saves[FOLDER_PATH]).toEqual({ state: 'saving' })
    expect(document.querySelector('.tab-dirty')).not.toBeNull()
    await tick(AUTOSAVE_DELAY_MS)
    expect(api.collections.updateSettings).toHaveBeenCalledTimes(1)
    expect(api.collections.updateSettings).toHaveBeenCalledWith(FOLDER_PATH, {
      scripts: { preRequest: 'let a = 1', postResponse: '' },
    })
    expect(useApp.getState().saves[FOLDER_PATH]).toBeUndefined()
  })

  it('saves collection auth with Save, without the inherit option', async () => {
    const api = await mounted()
    editFromMenu('Shop')
    fireEvent.click(screen.getByRole('button', { name: 'Auth type' }))
    expect(screen.queryByRole('menuitemradio', { name: 'Inherit from parent' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Bearer token' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Token' }), { target: { value: '{{token}}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await tick(0)
    expect(api.collections.updateSettings).toHaveBeenCalledTimes(1)
    expect(api.collections.updateSettings).toHaveBeenCalledWith(SHOP, { auth: { type: 'bearer', token: '{{token}}' } })
  })

  it('saves collection variables with Cmd/Ctrl+S', async () => {
    const api = await mounted()
    editFromMenu('Shop')
    openSection('Variables')
    fireEvent.change(screen.getByRole('textbox', { name: 'Variable value 1' }), { target: { value: 'http://x' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Variable key 2' }), { target: { value: 'token' } })
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true, metaKey: true })
    await tick(0)
    expect(api.collections.updateSettings).toHaveBeenCalledTimes(1)
    expect(api.collections.updateSettings).toHaveBeenCalledWith(SHOP, {
      variables: [
        { key: 'baseUrl', value: 'http://x', enabled: true },
        { key: 'token', value: '', enabled: true },
      ],
    })
  })

  it('saves collection scripts, clearing them with empty strings', async () => {
    const collections = tree()
    collections[0]!.scripts = { preRequest: 'old()', postResponse: '' }
    const api = await mounted(collections)
    editFromMenu('Shop')
    openSection('Scripts')
    fireEvent.change(screen.getByRole('textbox', { name: 'Pre-request script' }), { target: { value: '' } })
    await tick(AUTOSAVE_DELAY_MS)
    expect(api.collections.updateSettings).toHaveBeenCalledWith(SHOP, { scripts: { preRequest: '', postResponse: '' } })
  })

  it('keeps the draft and shows the failure when saving fails', async () => {
    const api = await mounted()
    api.collections.updateSettings.mockRejectedValueOnce(new Error('disk_full'))
    editFromMenu('Users')
    fireEvent.change(screen.getByRole('textbox', { name: 'Pre-request script' }), { target: { value: 'x()' } })
    await tick(AUTOSAVE_DELAY_MS)
    expect(useApp.getState().saves[FOLDER_PATH]).toEqual({ state: 'failed', error: 'disk_full' })
    expect(screen.getByRole('status')).toHaveTextContent('Save failed: disk_full')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await tick(0)
    expect(api.collections.updateSettings).toHaveBeenCalledTimes(2)
    expect(useApp.getState().saves[FOLDER_PATH]).toBeUndefined()
  })

  it('closes the tab when its collection is deleted', async () => {
    const api = await mounted()
    editFromMenu('Users')
    editFromMenu('Shop')
    useApp.getState().openRequest(REQUEST_PATH)
    expect(useApp.getState().openTabs).toHaveLength(3)
    api.collections.list.mockResolvedValue({ collections: [], errors: [] })
    await act(() => useApp.getState().remove(SHOP))
    expect(useApp.getState().openTabs).toEqual([])
    expect(useApp.getState().containerDrafts).toEqual({})
  })

  it('follows a rename of the collection', async () => {
    const api = await mounted()
    editFromMenu('Users')
    fireEvent.change(screen.getByRole('textbox', { name: 'Pre-request script' }), { target: { value: 'x()' } })
    const renamed = tree()
    renamed[0] = { ...renamed[0]!, path: 'collections/store', name: 'Store' }
    renamed[0].children = [folderNode('collections/store/users', 'Users', [])]
    api.collections.rename.mockResolvedValue('collections/store')
    api.collections.list.mockResolvedValue({ collections: renamed, errors: [] })
    await act(() => useApp.getState().rename(SHOP, 'Store'))
    expect(useApp.getState().activePath).toBe('collections/store/users')
    await tick(AUTOSAVE_DELAY_MS)
    expect(api.collections.updateSettings).toHaveBeenCalledWith('collections/store/users', {
      scripts: { preRequest: 'x()', postResponse: '' },
    })
  })

  it('writes a pending change when the tab is closed', async () => {
    const api = await mounted()
    editFromMenu('Users')
    fireEvent.change(screen.getByRole('textbox', { name: 'Pre-request script' }), { target: { value: 'y()' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close Users' }))
    await tick(0)
    expect(api.collections.updateSettings).toHaveBeenCalledWith(FOLDER_PATH, {
      scripts: { preRequest: 'y()', postResponse: '' },
    })
    expect(useApp.getState().openTabs).toEqual([])
  })
})
