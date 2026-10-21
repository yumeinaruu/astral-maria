// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { IS_MAC } from '../../src/renderer/src/lib/platform'
import { initialState, useApp } from '../../src/renderer/src/state/store'
import { useUi } from '../../src/renderer/src/state/ui'
import type { ImportReport } from '../../src/shared/types'
import { collectionTree, installApi, sampleTree, type MockApi } from './helpers'

const FULL = readFileSync(path.resolve(__dirname, '../fixtures/postman/full.v21.postman_collection.json'), 'utf8')

const IMPORTED: ImportReport = {
  imported: [
    {
      source: 'Pasted text',
      kind: 'collection',
      name: 'Acme Orders API',
      warnings: ['Request "Upload" has a file body; the file is not imported', 'Unsupported auth "hawk"'],
    },
  ],
  failed: [],
}

beforeEach(() => {
  useApp.setState(initialState())
  useUi.setState({ importOpen: false })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function openedApp(api: MockApi = installApi()) {
  const user = userEvent.setup()
  await useApp.getState().openWorkspace('/tmp/demo')
  render(<App />)
  return { api, user }
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Import' }))
  return screen.getByRole('dialog', { name: 'Import' })
}

describe('opening the Import dialog', () => {
  it('opens from the Import button in the sidebar header', async () => {
    const { user } = await openedApp()
    const dialog = await openDialog(user)
    expect(within(dialog).getByText('Drop Postman files here')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Choose files' })).toBeInTheDocument()
    expect(within(dialog).getByRole('textbox', { name: 'Paste raw text' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('opens from the sidebar More menu', async () => {
    const { user } = await openedApp()
    await user.click(screen.getByRole('button', { name: 'More sidebar actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Import…' }))
    expect(screen.getByRole('dialog', { name: 'Import' })).toBeInTheDocument()
  })

  it('opens with Cmd+O (Ctrl+O off macOS)', async () => {
    await openedApp()
    fireEvent.keyDown(window, { key: 'o', metaKey: IS_MAC, ctrlKey: !IS_MAC })
    expect(await screen.findByRole('dialog', { name: 'Import' })).toBeInTheDocument()
  })

  it('does not open with the shortcut while no workspace is open', async () => {
    installApi()
    render(<App />)
    fireEvent.keyDown(window, { key: 'o', metaKey: IS_MAC, ctrlKey: !IS_MAC })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('importing', () => {
  it('imports pasted text, lists the result with its warnings and reloads the sidebar', async () => {
    const api = installApi({ transfer: { importText: vi.fn().mockResolvedValue(IMPORTED) } })
    const { user } = await openedApp(api)
    const dialog = await openDialog(user)
    api.collections.list.mockResolvedValue({
      collections: [...sampleTree(), collectionTree('collections/acme-orders-api', 'Acme Orders API')],
      errors: [],
    })
    api.collections.list.mockClear()
    api.environments.list.mockClear()

    const textarea = within(dialog).getByRole('textbox', { name: 'Paste raw text' })
    await user.click(textarea)
    await user.paste(FULL)
    await user.click(within(dialog).getByRole('button', { name: 'Import' }))

    expect(api.transfer.importText).toHaveBeenCalledWith(FULL, 'Pasted text')
    expect(await within(dialog).findByText('Collection "Acme Orders API" imported')).toBeInTheDocument()
    const warnings = within(dialog).getByText('2 warnings')
    await user.click(warnings)
    expect(within(dialog).getByText('Unsupported auth "hawk"')).toBeVisible()
    await waitFor(() => expect(api.collections.list).toHaveBeenCalled())
    expect(api.environments.list).toHaveBeenCalled()
    // The new collection shows, expanded.
    expect(await screen.findByRole('treeitem', { name: 'Acme Orders API' })).toHaveAttribute('aria-expanded', 'true')
    expect(textarea).toHaveValue('')
  })

  it('names environments and globals in the results', async () => {
    const report: ImportReport = {
      imported: [
        { source: 'a.json', kind: 'environment', name: 'Dev', warnings: [] },
        { source: 'b.json', kind: 'globals', name: 'Workspace globals', warnings: ['One warning'] },
      ],
      failed: [],
    }
    const api = installApi({ transfer: { importFiles: vi.fn().mockResolvedValue(report) } })
    const { user } = await openedApp(api)
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Choose files' }))
    expect(api.transfer.importFiles).toHaveBeenCalledTimes(1)
    expect(await within(dialog).findByText('Environment "Dev" imported')).toBeInTheDocument()
    expect(within(dialog).getByText('Globals updated')).toBeInTheDocument()
    expect(within(dialog).getByText('1 warning')).toBeInTheDocument()
  })

  it('shows nothing and does not reload when the file dialog is cancelled', async () => {
    const { api, user } = await openedApp()
    const dialog = await openDialog(user)
    api.collections.list.mockClear()
    await user.click(within(dialog).getByRole('button', { name: 'Choose files' }))
    await waitFor(() => expect(api.transfer.importFiles).toHaveBeenCalled())
    expect(within(dialog).queryByRole('list', { name: 'Import results' })).toBeNull()
    expect(api.collections.list).not.toHaveBeenCalled()
  })

  it('sends dropped files one by one, in order, named by their file names', async () => {
    let release: (() => void) | null = null
    const importText = vi.fn(
      (_text: string, source: string) =>
        new Promise<ImportReport>((done) => {
          const report: ImportReport = {
            imported: [{ source, kind: 'environment', name: source, warnings: [] }],
            failed: [],
          }
          release = () => done(report)
        }),
    )
    const api = installApi({ transfer: { importText } })
    const { user } = await openedApp(api)
    const dialog = await openDialog(user)
    const zone = within(dialog).getByTestId('import-drop-zone')
    const files = [
      new File(['{"first":1}'], 'one.json', { type: 'application/json' }),
      new File(['{"second":2}'], 'two.json', { type: 'application/json' }),
    ]
    fireEvent.dragOver(zone, { dataTransfer: { files, types: ['Files'] } })
    expect(zone).toHaveClass('dragging')
    fireEvent.drop(zone, { dataTransfer: { files, types: ['Files'] } })
    expect(zone).not.toHaveClass('dragging')

    await waitFor(() => expect(importText).toHaveBeenCalledTimes(1))
    expect(importText).toHaveBeenLastCalledWith('{"first":1}', 'one.json')
    // Busy: the controls are disabled until every file is done.
    expect(within(dialog).getByRole('button', { name: 'Choose files' })).toBeDisabled()
    expect(within(dialog).getByRole('textbox', { name: 'Paste raw text' })).toBeDisabled()
    release!()
    await waitFor(() => expect(importText).toHaveBeenCalledTimes(2))
    expect(importText).toHaveBeenLastCalledWith('{"second":2}', 'two.json')
    release!()
    expect(await within(dialog).findByText('Environment "two.json" imported')).toBeInTheDocument()
    expect(within(dialog).getByText('Environment "one.json" imported')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Choose files' })).toBeEnabled()
  })

  it('shows a failed source with its message, and does not reload when nothing was imported', async () => {
    const report: ImportReport = {
      imported: [],
      failed: [{ source: 'Pasted text', message: 'Not a Postman collection or environment' }],
    }
    const api = installApi({ transfer: { importText: vi.fn().mockResolvedValue(report) } })
    const { user } = await openedApp(api)
    const dialog = await openDialog(user)
    api.collections.list.mockClear()
    await user.type(within(dialog).getByRole('textbox', { name: 'Paste raw text' }), 'nope')
    await user.click(within(dialog).getByRole('button', { name: 'Import' }))
    const line = await within(dialog).findByText(/Not a Postman collection or environment/)
    expect(line.closest('li')).toHaveClass('import-failed')
    expect(line.closest('li')).toHaveTextContent('Pasted text')
    expect(api.collections.list).not.toHaveBeenCalled()
    // The text stays, so it can be fixed.
    expect(within(dialog).getByRole('textbox', { name: 'Paste raw text' })).toHaveValue('nope')
  })

  it('reports a call that rejects as a failed line', async () => {
    const api = installApi({ transfer: { importText: vi.fn().mockRejectedValue(new Error('disk full')) } })
    const { user } = await openedApp(api)
    const dialog = await openDialog(user)
    await user.type(within(dialog).getByRole('textbox', { name: 'Paste raw text' }), 'x')
    await user.click(within(dialog).getByRole('button', { name: 'Import' }))
    expect(await within(dialog).findByText(/disk full/)).toBeInTheDocument()
  })
})

describe('dialog behaviour', () => {
  it('closes with Escape and gives focus back to the Import button', async () => {
    const { user } = await openedApp()
    const button = screen.getByRole('button', { name: 'Import' })
    await user.click(button)
    expect(screen.getByRole('dialog', { name: 'Import' })).toContainElement(document.activeElement as HTMLElement)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button).toHaveFocus()
  })

  it('keeps focus in the dialog after an import, so Escape still closes it', async () => {
    const report: ImportReport = {
      imported: [{ source: 'a.json', kind: 'environment', name: 'Dev', warnings: [] }],
      failed: [],
    }
    const api = installApi({ transfer: { importFiles: vi.fn().mockResolvedValue(report) } })
    const { user } = await openedApp(api)
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Choose files' }))
    await within(dialog).findByText('Environment "Dev" imported')
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes with the Close button', async () => {
    const { user } = await openedApp()
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps Tab focus inside the dialog', async () => {
    const { user } = await openedApp()
    const dialog = await openDialog(user)
    for (let i = 0; i < 8; i++) {
      await user.tab()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }
    for (let i = 0; i < 8; i++) {
      await user.tab({ shift: true })
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }
  })
})
