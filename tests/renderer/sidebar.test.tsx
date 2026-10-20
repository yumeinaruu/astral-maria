// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { initialState, useApp } from '../../src/renderer/src/state/store'
import {
  collectionTree,
  FOLDER_PATH,
  folderNode,
  installApi,
  REQUEST_PATH,
  requestNode,
  sampleTree,
  WS,
  type MockApi,
} from './helpers'

beforeEach(() => {
  useApp.setState(initialState())
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Renders the app with a workspace already open and the folder expanded. */
async function openedApp(api: MockApi = installApi()) {
  const user = userEvent.setup()
  await useApp.getState().openWorkspace('/tmp/demo')
  useApp.getState().setExpanded(FOLDER_PATH, true)
  render(<App />)
  return { api, user }
}

describe('WorkspaceGate', () => {
  it('lists recent workspaces and opens one on click', async () => {
    const api = installApi({ workspace: { recent: vi.fn().mockResolvedValue([WS]) } })
    const user = userEvent.setup()
    render(<App />)
    const recent = await screen.findByRole('button', { name: /Demo workspace/ })
    expect(recent).toHaveTextContent('/tmp/demo')
    await user.click(recent)
    expect(api.workspace.open).toHaveBeenCalledWith('/tmp/demo')
    expect(await screen.findByRole('tree')).toBeInTheDocument()
  })

  it('picks a directory before opening a workspace', async () => {
    const api = installApi({ workspace: { pickDirectory: vi.fn().mockResolvedValue('/picked') } })
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Open workspace' }))
    await waitFor(() => expect(api.workspace.open).toHaveBeenCalledWith('/picked'))
  })

  it('does nothing when the directory picker is cancelled', async () => {
    const api = installApi({ workspace: { pickDirectory: vi.fn().mockResolvedValue(null) } })
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Open workspace' }))
    expect(api.workspace.open).not.toHaveBeenCalled()
  })

  it('creates a workspace from a picked directory and a name', async () => {
    const api = installApi({ workspace: { pickDirectory: vi.fn().mockResolvedValue('/picked') } })
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Create workspace' }))
    await user.type(await screen.findByLabelText('Workspace name'), 'My APIs{Enter}')
    await waitFor(() => expect(api.workspace.create).toHaveBeenCalledWith('/picked', 'My APIs'))
    expect(await screen.findByRole('tree')).toBeInTheDocument()
  })
})

describe('Sidebar tree', () => {
  it('renders collections, folders and requests with a method badge', async () => {
    await openedApp()
    const tree = screen.getByRole('tree')
    expect(within(tree).getByRole('treeitem', { name: 'Shop' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(tree).getByRole('treeitem', { name: 'Users' })).toHaveAttribute('aria-expanded', 'true')
    const request = within(tree).getByRole('treeitem', { name: 'Get users' })
    expect(within(request).getByText('GET')).toBeInTheDocument()
    expect(screen.getByText('Demo workspace')).toBeInTheDocument()
  })

  it('collapses and expands folders on click, remembering state in the store', async () => {
    const { user } = await openedApp()
    await user.click(screen.getByRole('treeitem', { name: 'Users' }))
    expect(screen.queryByRole('treeitem', { name: 'Get users' })).not.toBeInTheDocument()
    expect(useApp.getState().expanded[FOLDER_PATH]).toBeFalsy()
    await user.click(screen.getByRole('treeitem', { name: 'Users' }))
    expect(screen.getByRole('treeitem', { name: 'Get users' })).toBeInTheDocument()
  })

  it('opens a request on click and marks it selected', async () => {
    const { user } = await openedApp()
    await user.click(screen.getByRole('treeitem', { name: 'Get users' }))
    expect(useApp.getState().activePath).toBe(REQUEST_PATH)
    expect(screen.getByRole('treeitem', { name: 'Get users' })).toHaveAttribute('aria-selected', 'true')
  })

  it('creates a request from the folder context menu, then reloads the tree', async () => {
    const { api, user } = await openedApp()
    api.collections.list.mockClear()
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('treeitem', { name: 'Users' }) })
    await user.click(screen.getByRole('menuitem', { name: 'New request' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'List all{Enter}')
    await waitFor(() => expect(api.collections.createRequest).toHaveBeenCalledWith(FOLDER_PATH, 'List all'))
    await waitFor(() => expect(api.collections.list).toHaveBeenCalled())
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument()
  })

  it('opens the same menu from the "..." button with the keyboard', async () => {
    const { api, user } = await openedApp()
    const more = within(screen.getByRole('treeitem', { name: 'Users' })).getByRole('button', {
      name: 'Actions for Users',
    })
    more.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    // third item is "Rename": the inline input appears with the current name
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Users')
    await user.keyboard('{Control>}a{/Control}Accounts{Enter}')
    await waitFor(() => expect(api.collections.rename).toHaveBeenCalledWith(FOLDER_PATH, 'Accounts'))
  })

  it('creates a collection from the header button', async () => {
    const { api, user } = await openedApp()
    await user.click(screen.getByRole('button', { name: 'New collection' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Fresh{Enter}')
    await waitFor(() => expect(api.collections.createCollection).toHaveBeenCalledWith('Fresh'))
  })

  it('cancels inline editing with Escape', async () => {
    const { api, user } = await openedApp()
    await user.click(screen.getByRole('button', { name: 'New collection' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Nope{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument()
    expect(api.collections.createCollection).not.toHaveBeenCalled()
  })

  it('asks for confirmation before deleting and calls remove only after it', async () => {
    const { api, user } = await openedApp()
    const confirmSpy = vi.fn()
    ;(window as unknown as { confirm: unknown }).confirm = confirmSpy
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('treeitem', { name: 'Get users' }) })
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Get users')
    expect(api.collections.remove).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(api.collections.remove).not.toHaveBeenCalled()

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('treeitem', { name: 'Get users' }) })
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.collections.remove).toHaveBeenCalledWith(REQUEST_PATH))
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('supports keyboard navigation, Enter, F2, Delete and Left/Right', async () => {
    const { api, user } = await openedApp()
    const tree = screen.getByRole('tree')
    tree.focus()
    await user.keyboard('{ArrowDown}') // Shop (first)
    expect(screen.getByRole('treeitem', { name: 'Shop' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}{ArrowDown}') // Users, Get users
    expect(screen.getByRole('treeitem', { name: 'Get users' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('treeitem', { name: 'Users' })).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowLeft}')
    expect(screen.queryByRole('treeitem', { name: 'Get users' })).not.toBeInTheDocument()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('treeitem', { name: 'Get users' })).toBeInTheDocument()

    await user.keyboard('{ArrowDown}{Enter}')
    expect(useApp.getState().activePath).toBe(REQUEST_PATH)

    await user.keyboard('{F2}')
    await user.keyboard('{Control>}a{/Control}Fetch{Enter}')
    await waitFor(() => expect(api.collections.rename).toHaveBeenCalledWith(REQUEST_PATH, 'Fetch'))

    await user.keyboard('{Delete}')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(api.collections.remove).not.toHaveBeenCalled()
  })

  it('moves a dragged request into a folder and before a sibling', async () => {
    const tree = [
      collectionTree('collections/shop', 'Shop', [
        folderNode('collections/shop/a', 'A', []),
        requestNode('collections/shop/one.request.json', 'One'),
        requestNode('collections/shop/two.request.json', 'Two'),
      ]),
    ]
    const api = installApi({ collections: { list: vi.fn().mockResolvedValue({ collections: tree, errors: [] }) } })
    await openedApp(api)
    const data: Record<string, string> = {}
    const dataTransfer = {
      setData: (k: string, v: string) => (data[k] = v),
      getData: (k: string) => data[k] ?? '',
      effectAllowed: '',
      dropEffect: '',
    }
    const one = screen.getByRole('treeitem', { name: 'One' })
    fireEvent.dragStart(one, { dataTransfer })
    fireEvent.dragOver(screen.getByRole('treeitem', { name: 'A' }), { dataTransfer })
    fireEvent.drop(screen.getByRole('treeitem', { name: 'A' }), { dataTransfer })
    await waitFor(() =>
      expect(api.collections.move).toHaveBeenCalledWith('collections/shop/one.request.json', 'collections/shop/a', 0),
    )

    fireEvent.dragStart(screen.getByRole('treeitem', { name: 'Two' }), { dataTransfer })
    fireEvent.drop(screen.getByRole('treeitem', { name: 'One' }), { dataTransfer })
    // siblings without the dragged item are [A, One]; dropping on One inserts at index 1
    await waitFor(() =>
      expect(api.collections.move).toHaveBeenLastCalledWith('collections/shop/two.request.json', 'collections/shop', 1),
    )
  })

  it('does not move a folder into itself', async () => {
    const api = installApi()
    await openedApp(api)
    const data: Record<string, string> = {}
    const dataTransfer = {
      setData: (k: string, v: string) => (data[k] = v),
      getData: (k: string) => data[k] ?? '',
    }
    fireEvent.dragStart(screen.getByRole('treeitem', { name: 'Users' }), { dataTransfer })
    fireEvent.drop(screen.getByRole('treeitem', { name: 'Get users' }), { dataTransfer })
    fireEvent.drop(screen.getByRole('treeitem', { name: 'Users' }), { dataTransfer })
    expect(api.collections.move).not.toHaveBeenCalled()
  })
})

describe('errors and disappearing data', () => {
  it('shows an error and does not crash when collections.list rejects on open', async () => {
    installApi({ collections: { list: vi.fn().mockRejectedValue(new Error('disk read failed')) } })
    const user = userEvent.setup()
    await useApp.getState().openWorkspace('/tmp/demo')
    render(<App />)
    expect(screen.getByRole('alert')).toHaveTextContent('disk read failed')
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('tree')).toBeInTheDocument()
  })

  it('lists load errors with their paths in a banner', async () => {
    const api = installApi({
      collections: {
        list: vi.fn().mockResolvedValue({
          collections: sampleTree(),
          errors: [{ path: 'collections/shop/broken.request.json', message: 'Unexpected token' }],
        }),
      },
    })
    await openedApp(api)
    const banner = screen.getByRole('region', { name: 'Files that could not be loaded' })
    expect(banner).toHaveTextContent('collections/shop/broken.request.json')
    expect(banner).toHaveTextContent('Unexpected token')
  })

  it('shows an error and refreshes when an item vanished before it was deleted', async () => {
    const { api, user } = await openedApp()
    api.collections.remove.mockRejectedValue(new Error('not_found: get-users.request.json'))
    api.collections.list.mockResolvedValue({
      collections: [collectionTree('collections/shop', 'Shop', [folderNode(FOLDER_PATH, 'Users', [])])],
      errors: [],
    })
    await user.click(screen.getByRole('treeitem', { name: 'Get users' }))
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('treeitem', { name: 'Get users' }) })
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not_found')
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: 'Get users' })).not.toBeInTheDocument())
    expect(useApp.getState().openTabs).toEqual([])
  })

  it('returns to the workspace gate with an error when the workspace folder disappears', async () => {
    const { api } = await openedApp()
    api.collections.list.mockRejectedValue(new Error('workspace_unavailable: cannot read workspace "Demo"'))
    await useApp.getState().refresh()
    expect(await screen.findByRole('button', { name: 'Open workspace' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('workspace_unavailable')
  })
})
