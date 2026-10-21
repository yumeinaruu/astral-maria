// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { IS_MAC } from '../../src/renderer/src/lib/platform'
import { searchRequests } from '../../src/renderer/src/lib/search'
import { applyTheme, loadTheme } from '../../src/renderer/src/lib/theme'
import { initialState, useApp } from '../../src/renderer/src/state/store'
import { loadUi, useUi } from '../../src/renderer/src/state/ui'
import { collectionTree, FOLDER_PATH, folderNode, installApi, REQUEST_PATH, requestNode, type MockApi } from './helpers'

const MOD = IS_MAC ? 'Meta' : 'Control'
const OTHER_PATH = 'collections/shop/users/create-user.request.json'
const BILLING_PATH = 'collections/billing/invoices.request.json'

function tree() {
  return [
    collectionTree('collections/shop', 'Shop', [
      folderNode(FOLDER_PATH, 'Users', [
        requestNode(REQUEST_PATH, 'Get users', 'GET'),
        requestNode(OTHER_PATH, 'Create user', 'POST'),
      ]),
    ]),
    collectionTree('collections/billing', 'Billing', [requestNode(BILLING_PATH, 'List invoices', 'GET')]),
  ]
}

async function openedApp(
  api: MockApi = installApi({ collections: { list: vi.fn().mockResolvedValue({ collections: tree(), errors: [] }) } }),
) {
  const user = userEvent.setup()
  await useApp.getState().openWorkspace('/tmp/demo')
  useApp.getState().setExpanded(FOLDER_PATH, true)
  render(<App />)
  return { api, user }
}

beforeEach(() => {
  localStorage.clear()
  useApp.setState(initialState())
  useUi.setState(loadUi())
  document.documentElement.removeAttribute('data-theme')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('quick open', () => {
  it('finds requests in every collection by name and location', () => {
    expect(searchRequests(tree(), 'user').map((h) => h.name)).toEqual(['Get users', 'Create user'])
    expect(searchRequests(tree(), 'billing').map((h) => h.location)).toEqual(['Billing'])
    expect(searchRequests(tree(), 'users create').map((h) => h.path)).toEqual([OTHER_PATH])
    // Names starting with the query come first.
    expect(searchRequests(tree(), 'create').map((h) => h.name)).toEqual(['Create user'])
    expect(searchRequests(tree(), '  ')).toEqual([])
  })

  it('filters while typing and opens the highlighted request with Enter', async () => {
    const { user } = await openedApp()
    const input = screen.getByRole('combobox', { name: 'Search requests' })
    await user.type(input, 'user')
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['GETGet usersShop / Users', 'POSTCreate userShop / Users'])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id)
    await user.keyboard('{Enter}')
    expect(useApp.getState().activePath).toBe(OTHER_PATH)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input).toHaveValue('')
  })

  it('opens a request on click, says when nothing matches, and closes with Escape', async () => {
    const { user } = await openedApp()
    const input = screen.getByRole('combobox', { name: 'Search requests' })
    await user.type(input, 'zzz')
    expect(screen.getByRole('listbox')).toHaveTextContent('No requests match')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.clear(input)
    await user.type(input, 'invoices')
    await user.click(screen.getByRole('option', { name: /List invoices/ }))
    expect(useApp.getState().activePath).toBe(BILLING_PATH)
  })

  it('is focused by Cmd/Ctrl+K', async () => {
    const { user } = await openedApp()
    await user.keyboard(`{${MOD}>}k{/${MOD}}`)
    expect(screen.getByRole('combobox', { name: 'Search requests' })).toHaveFocus()
  })
})

describe('sidebar', () => {
  it('filters the tree to matching requests and their ancestors', async () => {
    const { user } = await openedApp()
    // Billing is collapsed, but a match inside it is still shown.
    await user.type(screen.getByRole('searchbox', { name: 'Filter requests' }), 'invoice')
    const names = within(screen.getByRole('tree'))
      .getAllByRole('treeitem')
      .map((t) => t.getAttribute('aria-label'))
    expect(names).toEqual(['Billing', 'List invoices'])

    await user.clear(screen.getByRole('searchbox', { name: 'Filter requests' }))
    await user.type(screen.getByRole('searchbox', { name: 'Filter requests' }), 'USER')
    expect(
      within(screen.getByRole('tree'))
        .getAllByRole('treeitem')
        .map((t) => t.getAttribute('aria-label')),
    ).toEqual(['Shop', 'Users', 'Get users', 'Create user'])

    await user.type(screen.getByRole('searchbox', { name: 'Filter requests' }), 'xyz')
    expect(screen.getByText('No matching requests')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(6)
  })

  it('collapses sections and remembers it', async () => {
    const { user } = await openedApp()
    const toggle = screen.getByRole('button', { name: 'Collections' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('tree')).toBeNull()
    expect(loadUi().sections.collections).toBe(false)
  })

  it('collapses every folder from the more menu', async () => {
    const { user } = await openedApp()
    await user.click(screen.getByRole('button', { name: 'More sidebar actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Collapse all' }))
    expect(useApp.getState().expanded).toEqual({})
    expect(screen.queryByRole('treeitem', { name: 'Users' })).toBeNull()
  })

  it('shows an empty state with Create collection', async () => {
    const api = installApi({ collections: { list: vi.fn().mockResolvedValue({ collections: [], errors: [] }) } })
    const { user } = await openedApp(api)
    expect(screen.getByText('No collections yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create collection' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'First{Enter}')
    await waitFor(() => expect(api.collections.createCollection).toHaveBeenCalledWith('First'))
  })

  it('resizes with the keyboard within its limits and remembers the width', async () => {
    const { user } = await openedApp()
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    expect(handle).toHaveAttribute('aria-valuenow', '300')
    handle.focus()
    await user.keyboard('{ArrowRight}')
    expect(handle).toHaveAttribute('aria-valuenow', '316')
    await user.keyboard('{End}')
    expect(handle).toHaveAttribute('aria-valuenow', '520')
    await user.keyboard('{Home}')
    expect(screen.getByRole('complementary', { name: 'Sidebar' })).toHaveStyle({ width: '220px' })
    expect(loadUi().sidebarWidth).toBe(220)
  })

  it('is hidden and shown with the status bar button and Cmd/Ctrl+\\', async () => {
    const { user } = await openedApp()
    await user.click(screen.getByRole('button', { name: 'Hide sidebar' }))
    expect(screen.queryByRole('complementary', { name: 'Sidebar' })).toBeNull()
    await user.keyboard(`{${MOD}>}\\{/${MOD}}`)
    expect(screen.getByRole('complementary', { name: 'Sidebar' })).toBeInTheDocument()
  })

  it('marks the request of the active tab', async () => {
    const { user } = await openedApp()
    await user.click(screen.getByRole('treeitem', { name: 'Get users' }))
    expect(screen.getByRole('treeitem', { name: 'Get users' })).toHaveClass('active')
  })
})

describe('tab strip', () => {
  it('creates a new request next to the active one with +, and in the first collection without one', async () => {
    const { api, user } = await openedApp()
    await user.click(within(screen.getByRole('main')).getAllByRole('button', { name: 'New request' })[0])
    await waitFor(() => expect(api.collections.createRequest).toHaveBeenCalledWith('collections/shop', 'New request'))
    useApp.getState().openRequest(REQUEST_PATH)
    await user.keyboard(`{${MOD}>}t{/${MOD}}`)
    await waitFor(() => expect(api.collections.createRequest).toHaveBeenLastCalledWith(FOLDER_PATH, 'New request'))
  })

  it('opens the created request', async () => {
    const created = requestNode('collections/shop/new-request.request.json', 'New request')
    const list = vi
      .fn()
      .mockResolvedValueOnce({ collections: tree(), errors: [] })
      .mockResolvedValue({
        collections: [collectionTree('collections/shop', 'Shop', [...tree()[0].children, created]), tree()[1]],
        errors: [],
      })
    const { user } = await openedApp(installApi({ collections: { list } }))
    await user.click(within(screen.getByRole('main')).getAllByRole('button', { name: 'New request' })[0])
    await waitFor(() => expect(useApp.getState().activePath).toBe(created.path))
  })

  it('disables New request without collections', async () => {
    await openedApp(installApi({ collections: { list: vi.fn().mockResolvedValue({ collections: [], errors: [] }) } }))
    for (const b of screen.getAllByRole('button', { name: 'New request' })) expect(b).toBeDisabled()
  })

  it('closes the active tab with Cmd/Ctrl+W and middle-click, and cycles with Ctrl+Tab', async () => {
    const { user } = await openedApp()
    useApp.getState().openRequest(REQUEST_PATH)
    useApp.getState().openRequest(OTHER_PATH)
    useApp.getState().openEnvironment('globals')
    await user.keyboard('{Control>}{Tab}{/Control}')
    expect(useApp.getState().activePath).toBe(REQUEST_PATH)
    await user.keyboard('{Control>}{Shift>}{Tab}{/Shift}{/Control}')
    expect(useApp.getState().activePath).toBe('env:globals')

    await user.keyboard(`{${MOD}>}w{/${MOD}}`)
    expect(useApp.getState().openTabs.map((t) => t.path)).toEqual([REQUEST_PATH, OTHER_PATH])

    const tab = screen.getByRole('tab', { name: /Get users/ }).parentElement!
    fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(useApp.getState().openTabs.map((t) => t.path)).toEqual([OTHER_PATH])
  })

  it('lists every open tab in the tab menu and activates one', async () => {
    const { user } = await openedApp()
    useApp.getState().openRequest(REQUEST_PATH)
    useApp.getState().openEnvironment('globals')
    await user.click(screen.getByRole('button', { name: 'All tabs' }))
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent)).toEqual(['GET Get users', 'Globals (environment)'])
    expect(items[1]).toHaveAttribute('aria-checked', 'true')
    await user.click(items[0])
    expect(useApp.getState().activePath).toBe(REQUEST_PATH)
  })

  it('shows the method on request tabs and the name on environment tabs', async () => {
    await openedApp()
    useApp.getState().openRequest(OTHER_PATH)
    useApp.getState().openEnvironment('globals')
    expect(await screen.findByRole('tab', { name: /^POST\s*Create user$/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Globals' })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('header', () => {
  it('shows the workspace name and its folder in the workspace menu', async () => {
    const { user } = await openedApp()
    const button = screen.getByRole('button', { name: 'Workspace Demo workspace' })
    expect(button).toHaveTextContent('Demo workspace')
    await user.click(button)
    expect(screen.getByRole('menu', { name: 'Workspace' })).toHaveTextContent('/tmp/demo')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(button).toHaveFocus()
  })
})

describe('theme preference', () => {
  it('is System by default and survives broken storage', () => {
    expect(loadTheme()).toBe('system')
    localStorage.setItem('astral.theme', '"purple"')
    expect(loadTheme()).toBe('system')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(loadTheme()).toBe('system')
  })

  it('is chosen in the settings menu, stored, and applied as data-theme', async () => {
    const { user } = await openedApp()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(loadTheme()).toBe('dark')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Light' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'System' }))
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    expect(loadTheme()).toBe('system')
  })

  it('still applies when storage cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    useUi.getState().setTheme('dark')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    applyTheme('system')
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })

  it('remembers the layout toggle', async () => {
    const { user } = await openedApp()
    expect(useUi.getState().layout).toBe('side')
    await user.click(screen.getByRole('button', { name: 'Show the response below the request' }))
    expect(useUi.getState().layout).toBe('stacked')
    expect(loadUi().layout).toBe('stacked')
  })
})
