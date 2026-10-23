// @vitest-environment jsdom
// The Sync UI: the status-bar indicator and split button, the Set up sync, Commit and Conflicts dialogs, and Open
// from Git, with `window.astral` mocked.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { initialState, useApp } from '../../src/renderer/src/state/store'
import { loadUi, useUi } from '../../src/renderer/src/state/ui'
import { IDENTITY_MISSING_MESSAGE } from '../../src/shared/syncText'
import type { SyncConflictItem, SyncState } from '../../src/shared/types'
import { installApi, linkedState, NOT_LINKED, REQUEST_PATH, WS, type MockApi } from './helpers'

const CHANGES: SyncState['changes'] = [
  { path: 'collections/shop/users/get-users.request.json', kind: 'modified', label: 'Request "Get users" in Shop' },
  { path: 'environments/dev.json', kind: 'added', label: 'Environment "Dev"' },
  { path: 'collections/shop/old.request.json', kind: 'deleted', label: 'Request "Old" in Shop' },
  { path: 'collections/shop/moved.request.json', kind: 'renamed', label: 'Request "Moved" in Shop' },
]

const FIELDS_ITEM: SyncConflictItem = {
  id: 'collections/shop/users/get-users.request.json',
  label: 'Request "Get users" in Shop',
  kind: 'fields',
  fields: [
    { path: '["url"]', label: 'URL', ours: 'https://mine', theirs: 'https://theirs' },
    { path: '["method"]', label: 'Method', ours: 'PUT', theirs: 'POST' },
  ],
}
const FILE_ITEM: SyncConflictItem = { id: 'README.md', label: 'README.md', kind: 'file' }
const DELETED_REMOTE: SyncConflictItem = {
  id: 'environments/dev.json',
  label: 'Environment "Dev"',
  kind: 'deleted_remote',
}
const DELETED_LOCAL: SyncConflictItem = { id: 'environments/qa.json', label: 'Environment "QA"', kind: 'deleted_local' }

async function openApp(api: MockApi) {
  const user = userEvent.setup()
  await useApp.getState().openWorkspace('/tmp/demo')
  render(<App />)
  await waitFor(() => expect(api.git.state).toHaveBeenCalled())
  return { user }
}

function statusBar(): HTMLElement {
  return document.querySelector('footer.statusbar') as HTMLElement
}

async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(within(statusBar()).getByRole('button', { name: 'More sync actions' }))
  return screen.getByRole('menu', { name: 'Sync' })
}

beforeEach(() => {
  localStorage.clear()
  useApp.setState(initialState())
  useUi.setState(loadUi())
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('status bar indicator', () => {
  it('offers Set up sync when the workspace is not linked', async () => {
    const api = installApi()
    await openApp(api)
    expect(await within(statusBar()).findByRole('button', { name: 'Set up sync' })).toBeVisible()
    expect(within(statusBar()).queryByRole('button', { name: 'Sync' })).toBeNull()
  })

  it('shows the branch, the counts, the change dot and the split button when linked', async () => {
    const api = installApi({
      git: { state: vi.fn().mockResolvedValue(linkedState({ ahead: 2, behind: 1, changes: CHANGES })) },
    })
    await openApp(api)
    const bar = statusBar()
    expect(await within(bar).findByText('main')).toBeVisible()
    expect(within(bar).getByText('↑2 ↓1')).toBeVisible()
    expect(within(bar).getByRole('img', { name: 'Uncommitted changes' })).toBeVisible()
    expect(within(bar).getByRole('button', { name: 'Sync' })).toBeEnabled()
    expect(within(bar).queryByRole('button', { name: 'Set up sync' })).toBeNull()
  })

  it('hides the counts and the dot when there is nothing to show', async () => {
    const api = installApi({ git: { state: vi.fn().mockResolvedValue(linkedState()) } })
    await openApp(api)
    const bar = statusBar()
    await within(bar).findByText('main')
    expect(within(bar).queryByText(/↑/)).toBeNull()
    expect(within(bar).queryByRole('img', { name: 'Uncommitted changes' })).toBeNull()
  })

  it('during a merge: no change dot, Commit… disabled, and a Resolve conflicts banner', async () => {
    const api = installApi({
      git: {
        state: vi.fn().mockResolvedValue(linkedState({ merging: true, changes: CHANGES, conflicts: [FILE_ITEM] })),
      },
    })
    const { user } = await openApp(api)
    await within(statusBar()).findByText('main')
    expect(within(statusBar()).queryByRole('img', { name: 'Uncommitted changes' })).toBeNull()
    const menu = await openMenu(user)
    expect(within(menu).getByRole('menuitem', { name: 'Commit…' })).toBeDisabled()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Resolve conflicts' }))
    expect(screen.getByRole('dialog', { name: 'Resolve conflicts' })).toBeVisible()
  })

  it('refreshes the state when the window gains focus', async () => {
    const api = installApi()
    await openApp(api)
    const calls = api.git.state.mock.calls.length
    api.git.state.mockResolvedValue(linkedState())
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await within(statusBar()).findByText('main')
    expect(api.git.state.mock.calls.length).toBeGreaterThan(calls)
  })

  it('fetches silently every 10 minutes while linked, ignoring errors', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = installApi({
      git: {
        state: vi.fn().mockResolvedValue(linkedState()),
        fetch: vi.fn().mockRejectedValue(new Error('Git could not sign in to origin: denied')),
      },
    })
    await openApp(api)
    await within(statusBar()).findByText('main')
    expect(api.git.fetch).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    })
    expect(api.git.fetch).toHaveBeenCalledTimes(1)
    expect(useApp.getState().error).toBeNull()
  })
})

describe('Sync', () => {
  it('with changes opens the Commit dialog with the rows, a pre-filled message and the identity fields', async () => {
    const order: string[] = []
    const api = installApi({
      git: {
        state: vi.fn().mockResolvedValue(linkedState({ changes: CHANGES, identity: null })),
        setIdentity: vi.fn(async () => {
          order.push('setIdentity')
        }),
        sync: vi.fn(async () => {
          order.push('sync')
          return { kind: 'done', pulled: 1, pushed: 2 }
        }),
      },
    })
    const { user } = await openApp(api)
    await user.click(await within(statusBar()).findByRole('button', { name: 'Sync' }))
    const dialog = await screen.findByRole('dialog', { name: 'Commit changes' })
    const rows = within(within(dialog).getByRole('list', { name: 'Changes' })).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      '~Request "Get users" in Shop',
      '+Environment "Dev"',
      '−Request "Old" in Shop',
      '→Request "Moved" in Shop',
    ])
    expect(within(dialog).getByLabelText('Commit message')).toHaveValue('Update 3 requests and 1 environment')
    expect(within(dialog).getByText(/saved for this repository only/i)).toBeVisible()
    const submit = within(dialog).getByRole('button', { name: 'Commit and sync' })
    expect(submit).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Name'), 'Dana')
    await user.type(within(dialog).getByLabelText('Email'), 'dana@example.com')
    await user.clear(within(dialog).getByLabelText('Commit message'))
    await user.type(within(dialog).getByLabelText('Commit message'), 'Tweak users')
    await user.click(submit)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Commit changes' })).toBeNull())
    expect(api.git.setIdentity).toHaveBeenCalledWith('Dana', 'dana@example.com')
    expect(api.git.sync).toHaveBeenCalledWith('Tweak users')
    expect(order).toEqual(['setIdentity', 'sync'])
    expect(await within(statusBar()).findByRole('status')).toHaveTextContent('Pulled 1, pushed 2')
  })

  it('shows the identity fields when the commit asks for them', async () => {
    const api = installApi({
      git: {
        state: vi.fn().mockResolvedValue(linkedState({ changes: CHANGES })),
        sync: vi
          .fn()
          .mockRejectedValueOnce(new Error(IDENTITY_MISSING_MESSAGE))
          .mockResolvedValue({ kind: 'up_to_date' }),
      },
    })
    const { user } = await openApp(api)
    await user.click(await within(statusBar()).findByRole('button', { name: 'Sync' }))
    const dialog = await screen.findByRole('dialog', { name: 'Commit changes' })
    expect(within(dialog).queryByLabelText('Name')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Commit and sync' }))
    expect(await within(dialog).findByLabelText('Name')).toBeVisible()
    expect(useApp.getState().error).toBeNull()
  })

  it('with no changes calls sync(null) and reports Up to date', async () => {
    const api = installApi({ git: { state: vi.fn().mockResolvedValue(linkedState()) } })
    const { user } = await openApp(api)
    await user.click(await within(statusBar()).findByRole('button', { name: 'Sync' }))
    await waitFor(() => expect(api.git.sync).toHaveBeenCalledWith(null))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await within(statusBar()).findByRole('status')).toHaveTextContent('Up to date')
  })

  it('puts errors in the error banner', async () => {
    const api = installApi({
      git: {
        state: vi.fn().mockResolvedValue(linkedState()),
        sync: vi.fn().mockRejectedValue(new Error('Git could not sign in to origin: denied')),
      },
    })
    const { user } = await openApp(api)
    await user.click(await within(statusBar()).findByRole('button', { name: 'Sync' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Git could not sign in to origin: denied')
  })

  it('flushes drafts before the operation and refreshes the workspace after it', async () => {
    const order: string[] = []
    const api = installApi({
      workspace: {
        reload: vi.fn(async () => {
          order.push('reload')
          return { ...WS, name: 'Renamed by a pull' }
        }),
      },
      collections: {
        saveRequest: vi.fn(async () => {
          order.push('save')
          return 'rev-2'
        }),
      },
      git: {
        state: vi.fn().mockResolvedValue(linkedState()),
        pull: vi.fn(async () => {
          order.push('pull')
          return { kind: 'done', pulled: 3, pushed: 0 }
        }),
      },
    })
    const { user } = await openApp(api)
    await within(statusBar()).findByText('main')
    useApp.getState().openRequest(REQUEST_PATH)
    useApp.getState().editDraft(REQUEST_PATH, (d) => ({ ...d, url: 'https://changed' }))
    const lists = api.collections.list.mock.calls.length
    const menu = await openMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Pull only' }))
    await waitFor(() => expect(order).toContain('reload'))
    expect(order.indexOf('save')).toBeLessThan(order.indexOf('pull'))
    expect(order.indexOf('pull')).toBeLessThan(order.indexOf('reload'))
    expect(api.collections.list.mock.calls.length).toBeGreaterThan(lists)
    expect(await screen.findByText('Renamed by a pull')).toBeVisible()
    expect(useApp.getState().openTabs.map((t) => t.path)).toEqual([REQUEST_PATH])
    expect(await within(statusBar()).findByRole('status')).toHaveTextContent('Pulled 3')
  })
})

describe('the sync menu', () => {
  it('Push only reports what was pushed', async () => {
    const api = installApi({
      git: {
        state: vi.fn().mockResolvedValue(linkedState({ ahead: 1 })),
        push: vi.fn().mockResolvedValue({ kind: 'done', pulled: 0, pushed: 1 }),
      },
    })
    const { user } = await openApp(api)
    await within(statusBar()).findByText('main')
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Push only' }))
    expect(await within(statusBar()).findByRole('status')).toHaveTextContent('Pushed 1')
    expect(api.git.push).toHaveBeenCalledTimes(1)
  })

  it('Commit… opens the Commit dialog and commits without syncing', async () => {
    const api = installApi({ git: { state: vi.fn().mockResolvedValue(linkedState({ changes: CHANGES.slice(0, 1) })) } })
    const { user } = await openApp(api)
    await within(statusBar()).findByText('main')
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Commit…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Commit changes' })
    expect(within(dialog).getByLabelText('Commit message')).toHaveValue('Update 1 request')
    expect(within(dialog).queryByRole('button', { name: 'Commit and sync' })).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Commit' }))
    await waitFor(() => expect(api.git.commit).toHaveBeenCalledWith('Update 1 request'))
    expect(api.git.sync).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('Cancel closes the Commit dialog without committing', async () => {
    const api = installApi({ git: { state: vi.fn().mockResolvedValue(linkedState({ changes: CHANGES })) } })
    const { user } = await openApp(api)
    await user.click(await within(statusBar()).findByRole('button', { name: 'Sync' }))
    const dialog = await screen.findByRole('dialog', { name: 'Commit changes' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.git.sync).not.toHaveBeenCalled()
  })

  it('Copy remote URL writes it to the clipboard', async () => {
    const api = installApi({ git: { state: vi.fn().mockResolvedValue(linkedState()) } })
    const { user } = await openApp(api)
    await within(statusBar()).findByText('main')
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Copy remote URL' }))
    expect(writeText).toHaveBeenCalledWith('git@example.com:team/apis.git')
  })

  it('Unlink… asks first, then removes the remote', async () => {
    const api = installApi({ git: { state: vi.fn().mockResolvedValue(linkedState()) } })
    const { user } = await openApp(api)
    await within(statusBar()).findByText('main')
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Unlink…' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Unlink from git' })
    expect(api.git.unlink).not.toHaveBeenCalled()
    api.git.state.mockResolvedValue(NOT_LINKED)
    await user.click(within(confirm).getByRole('button', { name: 'Unlink' }))
    await waitFor(() => expect(api.git.unlink).toHaveBeenCalledTimes(1))
    expect(await within(statusBar()).findByRole('button', { name: 'Set up sync' })).toBeVisible()
  })

  it('Unlink… can be cancelled', async () => {
    const api = installApi({ git: { state: vi.fn().mockResolvedValue(linkedState()) } })
    const { user } = await openApp(api)
    await within(statusBar()).findByText('main')
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Unlink…' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(api.git.unlink).not.toHaveBeenCalled()
  })
})

describe('Set up sync', () => {
  it('links to the repository URL', async () => {
    const api = installApi()
    const { user } = await openApp(api)
    await user.click(await within(statusBar()).findByRole('button', { name: 'Set up sync' }))
    const dialog = screen.getByRole('dialog', { name: 'Set up sync' })
    const url = within(dialog).getByLabelText('Repository URL')
    expect(url).toHaveAttribute('placeholder', 'git@github.com:you/repo.git')
    expect(within(dialog).getByText(/system git/i)).toBeVisible()
    api.git.state.mockResolvedValue(linkedState())
    await user.type(url, 'git@example.com:team/apis.git')
    await user.click(within(dialog).getByRole('button', { name: 'Link' }))
    await waitFor(() => expect(api.git.link).toHaveBeenCalledWith('git@example.com:team/apis.git'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await within(statusBar()).findByText('main')).toBeVisible()
  })

  it('shows errors inline', async () => {
    const api = installApi({ git: { link: vi.fn().mockRejectedValue(new Error('Git could not sign in to x: no')) } })
    const { user } = await openApp(api)
    await user.click(await within(statusBar()).findByRole('button', { name: 'Set up sync' }))
    const dialog = screen.getByRole('dialog', { name: 'Set up sync' })
    await user.type(within(dialog).getByLabelText('Repository URL'), 'x')
    await user.click(within(dialog).getByRole('button', { name: 'Link' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Git could not sign in to x: no')
    expect(useApp.getState().error).toBeNull()
  })

  it('asks for the identity when linking needs a commit, then retries', async () => {
    const api = installApi({
      git: {
        link: vi.fn().mockRejectedValueOnce(new Error(IDENTITY_MISSING_MESSAGE)).mockResolvedValue(linkedState()),
      },
    })
    const { user } = await openApp(api)
    await user.click(await within(statusBar()).findByRole('button', { name: 'Set up sync' }))
    const dialog = screen.getByRole('dialog', { name: 'Set up sync' })
    await user.type(within(dialog).getByLabelText('Repository URL'), 'git@example.com:team/apis.git')
    await user.click(within(dialog).getByRole('button', { name: 'Link' }))
    await user.type(await within(dialog).findByLabelText('Name'), 'Dana')
    await user.type(within(dialog).getByLabelText('Email'), 'dana@example.com')
    await user.click(within(dialog).getByRole('button', { name: 'Link' }))
    await waitFor(() => expect(api.git.link).toHaveBeenCalledTimes(2))
    expect(api.git.setIdentity).toHaveBeenCalledWith('Dana', 'dana@example.com')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('opens the conflicts dialog when linking stops on conflicts', async () => {
    const api = installApi({
      git: { link: vi.fn().mockResolvedValue(linkedState({ merging: true, conflicts: [FILE_ITEM] })) },
    })
    const { user } = await openApp(api)
    await user.click(await within(statusBar()).findByRole('button', { name: 'Set up sync' }))
    const dialog = screen.getByRole('dialog', { name: 'Set up sync' })
    await user.type(within(dialog).getByLabelText('Repository URL'), 'x')
    api.git.state.mockResolvedValue(linkedState({ merging: true, conflicts: [FILE_ITEM] }))
    await user.click(within(dialog).getByRole('button', { name: 'Link' }))
    expect(await screen.findByRole('dialog', { name: 'Resolve conflicts' })).toBeVisible()
  })
})

describe('conflicts dialog', () => {
  async function conflicted(items: SyncConflictItem[], over: Partial<MockApi['git']> = {}) {
    const state = linkedState({ merging: true, conflicts: items })
    const api: MockApi = installApi({
      git: {
        state: vi.fn().mockResolvedValue(linkedState()),
        // From then on the repository is merging.
        sync: vi.fn(async () => {
          api.git.state.mockResolvedValue(state)
          return { kind: 'conflicts', state }
        }),
        ...over,
      },
    })
    const { user } = await openApp(api)
    await user.click(await within(statusBar()).findByRole('button', { name: 'Sync' }))
    const dialog = await screen.findByRole('dialog', { name: 'Resolve conflicts' })
    return { api, user, dialog }
  }

  it('opens on a conflicts outcome; per-field radios resolve with the field map', async () => {
    const { api, user, dialog } = await conflicted([FIELDS_ITEM, FILE_ITEM])
    const item = within(dialog).getByRole('group', { name: FIELDS_ITEM.label })
    expect(within(item).getByRole('columnheader', { name: 'Yours' })).toBeVisible()
    expect(within(item).getByText('https://theirs')).toBeVisible()
    const apply = within(item).getByRole('button', { name: 'Apply' })
    expect(apply).toBeDisabled()
    await user.click(within(item).getByRole('radio', { name: 'URL: yours' }))
    expect(apply).toBeDisabled()
    await user.click(within(item).getByRole('radio', { name: 'Method: theirs' }))
    api.git.resolve.mockResolvedValue(linkedState({ merging: true, conflicts: [FILE_ITEM] }))
    await user.click(apply)
    await waitFor(() =>
      expect(api.git.resolve).toHaveBeenCalledWith(FIELDS_ITEM.id, {
        fields: { '["url"]': 'ours', '["method"]': 'theirs' },
      }),
    )
  })

  it('All mine and All theirs choose every field', async () => {
    const { api, user, dialog } = await conflicted([FIELDS_ITEM])
    const item = within(dialog).getByRole('group', { name: FIELDS_ITEM.label })
    await user.click(within(item).getByRole('button', { name: 'All theirs' }))
    expect(within(item).getByRole('radio', { name: 'URL: theirs' })).toBeChecked()
    expect(within(item).getByRole('radio', { name: 'Method: theirs' })).toBeChecked()
    await user.click(within(item).getByRole('button', { name: 'All mine' }))
    await user.click(within(item).getByRole('button', { name: 'Apply' }))
    await waitFor(() =>
      expect(api.git.resolve).toHaveBeenCalledWith(FIELDS_ITEM.id, {
        fields: { '["url"]': 'ours', '["method"]': 'ours' },
      }),
    )
  })

  it('offers whole-file choices, the editor and the edited file for a file item', async () => {
    const { api, user, dialog } = await conflicted([FILE_ITEM])
    const item = within(dialog).getByRole('group', { name: FILE_ITEM.label })
    await user.click(within(item).getByRole('button', { name: 'Open in editor' }))
    expect(api.git.openInEditor).toHaveBeenCalledWith('README.md')
    api.git.resolve.mockRejectedValueOnce(new Error('"README.md" still has conflict markers or is not valid JSON'))
    await user.click(within(item).getByRole('button', { name: 'Use edited file' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('still has conflict markers')
    expect(api.git.resolve).toHaveBeenLastCalledWith('README.md', 'edited')
    await user.click(within(item).getByRole('button', { name: 'Keep theirs' }))
    await waitFor(() => expect(api.git.resolve).toHaveBeenLastCalledWith('README.md', 'theirs'))
  })

  it('maps the deleted items to the right sides', async () => {
    const { api, user, dialog } = await conflicted([DELETED_REMOTE, DELETED_LOCAL])
    const remote = within(dialog).getByRole('group', { name: DELETED_REMOTE.label })
    expect(within(remote).getByText('Deleted on the remote')).toBeVisible()
    await user.click(within(remote).getByRole('button', { name: 'Keep mine' }))
    await waitFor(() => expect(api.git.resolve).toHaveBeenLastCalledWith(DELETED_REMOTE.id, 'ours'))
    const local = within(dialog).getByRole('group', { name: DELETED_LOCAL.label })
    expect(within(local).getByText('Deleted here')).toBeVisible()
    await user.click(within(local).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.git.resolve).toHaveBeenLastCalledWith(DELETED_LOCAL.id, 'ours'))
    await user.click(within(local).getByRole('button', { name: 'Keep theirs' }))
    await waitFor(() => expect(api.git.resolve).toHaveBeenLastCalledWith(DELETED_LOCAL.id, 'theirs'))
  })

  it('enables Finish and push only once everything is resolved', async () => {
    const { api, user, dialog } = await conflicted([FILE_ITEM])
    const finish = within(dialog).getByRole('button', { name: 'Finish and push' })
    expect(finish).toBeDisabled()
    const resolved = linkedState({ merging: true, conflicts: [] })
    api.git.resolve.mockResolvedValue(resolved)
    api.git.state.mockResolvedValue(resolved)
    await user.click(within(dialog).getByRole('button', { name: 'Keep mine' }))
    await waitFor(() => expect(finish).toBeEnabled())
    expect(within(dialog).getByText('Resolved')).toBeVisible()
    api.git.finishMerge.mockResolvedValue({ kind: 'done', pulled: 1, pushed: 2 })
    api.git.state.mockResolvedValue(linkedState())
    await user.click(finish)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.git.finishMerge).toHaveBeenCalledTimes(1)
    expect(await within(statusBar()).findByRole('status')).toHaveTextContent('Pulled 1, pushed 2')
  })

  it('says Finish for a merge that did not come from a sync', async () => {
    const state = linkedState({ merging: true, conflicts: [FILE_ITEM] })
    const api = installApi({ git: { state: vi.fn().mockResolvedValue(state) } })
    const { user } = await openApp(api)
    await user.click(await screen.findByRole('button', { name: 'Resolve conflicts' }))
    const dialog = screen.getByRole('dialog', { name: 'Resolve conflicts' })
    expect(within(dialog).getByRole('button', { name: 'Finish' })).toBeDisabled()
  })

  it('asks before aborting the merge', async () => {
    const { api, user, dialog } = await conflicted([FILE_ITEM])
    await user.click(within(dialog).getByRole('button', { name: 'Abort merge' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Abort the merge?' })
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(api.git.abortMerge).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Abort merge' }))
    api.git.state.mockResolvedValue(linkedState())
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Abort merge' }))
    await waitFor(() => expect(api.git.abortMerge).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('Open from Git', () => {
  it('clones from the gate and opens the cloned workspace', async () => {
    const cloned = { id: 'w2', name: 'Team APIs', dir: '/tmp/team' }
    const api = installApi({ git: { clone: vi.fn().mockResolvedValue(cloned) } })
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Open from Git' }))
    const dialog = screen.getByRole('dialog', { name: 'Open from Git' })
    await user.type(within(dialog).getByLabelText('Repository URL'), 'git@example.com:team/apis.git')
    await user.click(within(dialog).getByRole('button', { name: 'Clone' }))
    await waitFor(() => expect(useApp.getState().workspace).toEqual(cloned))
    expect(api.git.clone).toHaveBeenCalledWith('git@example.com:team/apis.git')
    expect(await screen.findByText('Team APIs')).toBeVisible()
  })

  it('stays on the gate when the folder picker is cancelled', async () => {
    const api = installApi()
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Open from Git' }))
    const dialog = screen.getByRole('dialog', { name: 'Open from Git' })
    await user.type(within(dialog).getByLabelText('Repository URL'), 'x')
    await user.click(within(dialog).getByRole('button', { name: 'Clone' }))
    await waitFor(() => expect(api.git.clone).toHaveBeenCalled())
    expect(useApp.getState().workspace).toBeNull()
    expect(screen.getByRole('button', { name: 'Create workspace' })).toBeVisible()
  })

  it('sits in the workspace menu and writes the drafts first', async () => {
    const order: string[] = []
    const cloned = { id: 'w2', name: 'Team APIs', dir: '/tmp/team' }
    const api = installApi({
      collections: {
        saveRequest: vi.fn(async () => {
          order.push('save')
          return 'rev-2'
        }),
      },
      git: {
        clone: vi.fn(async () => {
          order.push('clone')
          return cloned
        }),
      },
    })
    const { user } = await openApp(api)
    useApp.getState().openRequest(REQUEST_PATH)
    useApp.getState().editDraft(REQUEST_PATH, (d) => ({ ...d, url: 'https://changed' }))
    await user.click(screen.getByRole('button', { name: `Workspace ${WS.name}` }))
    await user.click(screen.getByRole('menuitem', { name: 'Open from Git…' }))
    const dialog = screen.getByRole('dialog', { name: 'Open from Git' })
    await user.type(within(dialog).getByLabelText('Repository URL'), 'git@example.com:team/apis.git')
    await user.click(within(dialog).getByRole('button', { name: 'Clone' }))
    await waitFor(() => expect(useApp.getState().workspace).toEqual(cloned))
    expect(order).toEqual(['save', 'clone'])
  })
})
