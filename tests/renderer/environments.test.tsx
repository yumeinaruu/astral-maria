// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { IS_MAC } from '../../src/renderer/src/lib/platform'
import { initialState, useApp } from '../../src/renderer/src/state/store'
import type { Environment, LoadError, SendResult } from '../../src/shared/types'
import { installApi, REQUEST_PATH } from './helpers'

const DEV: Environment = {
  id: 'dev',
  name: 'Dev',
  variables: [{ key: 'host', value: 'dev.example.com', currentValue: 'localhost', secret: false, enabled: true }],
}
const PROD: Environment = { id: 'prod', name: 'Prod', variables: [] }

const SECRET_TEXT = 'hunter2-top-secret'

interface Disk {
  envs: Environment[]
  errors: LoadError[]
}

/** A mocked `environments` API backed by an in-memory list, like the real store. */
function diskApi(disk: Disk) {
  return {
    list: vi.fn(async () => ({ environments: structuredClone(disk.envs), errors: disk.errors })),
    save: vi.fn(async (env: Environment) => {
      const copy = structuredClone(env)
      const i = disk.envs.findIndex((e) => e.id === copy.id)
      if (i < 0) disk.envs.push(copy)
      else disk.envs[i] = copy
    }),
    remove: vi.fn(async (id: string) => {
      disk.envs = disk.envs.filter((e) => e.id !== id)
    }),
  }
}

async function mount(envs: Environment[] = [DEV, PROD], overrides: Parameters<typeof installApi>[0] = {}) {
  const disk: Disk = { envs: structuredClone(envs), errors: [] }
  const environments = diskApi(disk)
  const api = installApi({ ...overrides, environments: { ...environments, ...overrides.environments } })
  const user = userEvent.setup()
  await useApp.getState().openWorkspace('/tmp/demo')
  render(<App />)
  return { api, user, disk, environments }
}

/** Opens the editor tab of `name` from the sidebar and returns its panel. */
async function openEditor(user: ReturnType<typeof userEvent.setup>, name = 'Globals') {
  await user.click(within(screen.getByRole('list', { name: 'Environments' })).getByRole('button', { name }))
  return screen.findByRole('tabpanel')
}

function rowInput(label: string, n = 1): HTMLInputElement {
  return screen.getByLabelText(`${label} ${n}`) as HTMLInputElement
}

async function makeSecret(user: ReturnType<typeof userEvent.setup>, n = 1, secret = true) {
  await user.click(screen.getByRole('button', { name: `Type ${n}` }))
  await user.click(screen.getByRole('menuitemradio', { name: secret ? 'Secret' : 'Default' }))
}

/** Picks an item of the "⋯" menu of variable `n`. */
async function rowAction(user: ReturnType<typeof userEvent.setup>, n: number, item: string) {
  await user.click(screen.getByRole('button', { name: `Actions for variable ${n}` }))
  await user.click(screen.getByRole('menuitem', { name: item }))
}

/** Moves the value of variable `n` to the shared or the local side. */
async function setStorage(user: ReturnType<typeof userEvent.setup>, n: number, to: 'Shared' | 'Local') {
  await user.click(screen.getByRole('button', { name: `Storage of value ${n}` }))
  await user.click(screen.getByRole('menuitemradio', { name: new RegExp(`^${to}:`) }))
}

const MOD = IS_MAC ? 'Meta' : 'Control'

beforeEach(() => {
  useApp.setState(initialState())
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function chooseEnvironment(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: 'Environment' }))
  await user.click(screen.getByRole('menuitemradio', { name }))
}

describe('environment selector', () => {
  it('lists No environment and the non-globals environments, and selects one', async () => {
    const { user } = await mount([DEV, PROD, { id: 'globals', name: 'Globals', variables: [] }])
    const button = screen.getByRole('button', { name: 'Environment' })
    expect(button).toHaveTextContent('No environment')
    await user.click(button)
    expect(screen.getAllByRole('menuitemradio').map((o) => o.textContent)).toEqual(['No environment', 'Dev', 'Prod'])
    expect(screen.getByRole('menuitemradio', { name: 'No environment' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('menuitemradio', { name: 'Dev' }))
    expect(useApp.getState().activeEnvironmentId).toBe('dev')
    expect(button).toHaveTextContent('Dev')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('makes the next send use the selected environment id, and null for No environment', async () => {
    const result: SendResult = { ok: false, error: { code: 'x', message: 'y' } }
    const send = vi.fn().mockResolvedValue(result)
    const { user } = await mount([DEV, PROD], { http: { send } })
    useApp.getState().openRequest(REQUEST_PATH)

    await chooseEnvironment(user, 'Dev')
    await user.click(await screen.findByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][1]).toEqual({ collectionPath: 'collections/shop', environmentId: 'dev' })

    await chooseEnvironment(user, 'No environment')
    await user.click(await screen.findByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1][1]).toEqual({ collectionPath: 'collections/shop', environmentId: null })
  })

  it('resets the selection with a notice when the active environment disappears after a refresh', async () => {
    const { user, disk } = await mount()
    await chooseEnvironment(user, 'Dev')
    disk.envs = disk.envs.filter((e) => e.id !== 'dev')
    await useApp.getState().refresh()
    expect(useApp.getState().activeEnvironmentId).toBeNull()
    expect(screen.getByRole('button', { name: 'Environment' })).toHaveTextContent('No environment')
    expect(await screen.findByRole('status')).toHaveTextContent('Dev')
    await user.click(screen.getByRole('button', { name: 'Dismiss notice' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('environments in the sidebar', () => {
  it('lists Globals first even when globals.json does not exist yet', async () => {
    await mount()
    const list = screen.getByRole('list', { name: 'Environments' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Globals', 'Dev', 'Prod'])
    // Globals is always applied, so it has no check and no rename or delete.
    expect(within(list).queryByRole('button', { name: /Activate Globals|Actions for Globals/ })).toBeNull()
  })

  it('activates an environment with its check, and deactivates it with a second click', async () => {
    const { user } = await mount()
    const activate = screen.getByRole('button', { name: 'Activate Dev' })
    expect(activate).toHaveAttribute('aria-pressed', 'false')
    await user.click(activate)
    expect(useApp.getState().activeEnvironmentId).toBe('dev')
    expect(screen.getByRole('button', { name: 'Environment' })).toHaveTextContent('Dev')
    const deactivate = screen.getByRole('button', { name: 'Deactivate Dev' })
    expect(deactivate).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Activate Prod' }))
    expect(useApp.getState().activeEnvironmentId).toBe('prod')
    await user.click(screen.getByRole('button', { name: 'Deactivate Prod' }))
    expect(useApp.getState().activeEnvironmentId).toBeNull()
    // Activating does not open the editor.
    expect(useApp.getState().openTabs).toEqual([])
  })

  it('opens the editor as a tab when the name is clicked, and marks the row', async () => {
    const { user } = await mount()
    await openEditor(user, 'Dev')
    expect(useApp.getState().activePath).toBe('env:dev')
    expect(screen.getByRole('tab', { name: /Dev/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Dev' })).toHaveAttribute('aria-current', 'page')
    expect(rowInput('Variable name')).toHaveValue('host')
  })

  it('renames an environment from its row menu', async () => {
    const { user, environments } = await mount()
    await user.click(screen.getByRole('button', { name: 'Actions for Prod' }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByRole('textbox', { name: 'Name' })
    await user.clear(input)
    await user.type(input, 'Production{Enter}')
    await waitFor(() =>
      expect(environments.save).toHaveBeenCalledWith({ id: 'prod', name: 'Production', variables: [] }),
    )
  })

  it('refuses a rename to a name that is taken', async () => {
    const { user, environments } = await mount()
    await user.click(screen.getByRole('button', { name: 'Actions for Prod' }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByRole('textbox', { name: 'Name' })
    await user.clear(input)
    await user.type(input, 'dev{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('Another environment already has this name')
    expect(environments.save).not.toHaveBeenCalled()
  })

  it('deletes an environment from its row menu after confirmation, closing its tab', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Prod')
    await user.click(screen.getByRole('button', { name: 'Actions for Prod' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(environments.remove).toHaveBeenCalledWith('prod'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Prod' })).toBeNull())
    expect(useApp.getState().openTabs).toEqual([])
  })

  it('creates a new environment on disk at once, opens it and renames its row inline', async () => {
    const { user, environments, disk } = await mount()
    await user.click(screen.getByRole('button', { name: 'New environment' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
    const created = environments.save.mock.calls[0][0] as Environment
    expect(created).toMatchObject({ name: 'New environment', variables: [] })
    expect(disk.envs.map((e) => e.name)).toContain('New environment')
    expect(useApp.getState().activePath).toBe(`env:${created.id}`)
    expect(await screen.findByLabelText('Environment name')).toHaveValue('New environment')
    expect(screen.queryByText('Not saved yet')).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete environment' })).toBeInTheDocument()
    // The row is in inline rename with the whole name selected.
    const rename = within(screen.getByRole('list', { name: 'Environments' })).getByRole('textbox', {
      name: 'Name',
    }) as HTMLInputElement
    expect(rename).toHaveFocus()
    expect([rename.selectionStart, rename.selectionEnd]).toEqual([0, 'New environment'.length])
    await user.keyboard('Staging{Enter}')
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(2))
    expect(environments.save.mock.calls[1][0]).toMatchObject({ id: created.id, name: 'Staging' })
    expect(within(screen.getByRole('list', { name: 'Environments' })).getByRole('button', { name: 'Staging' }))
    expect(screen.getByLabelText('Environment name')).toHaveValue('Staging')
    // Nothing is left unsaved.
    expect(useApp.getState().unsavedPaths()).toEqual([])
  })

  it('numbers the names of new environments', async () => {
    const { user, environments } = await mount([DEV, { id: 'n', name: 'New environment', variables: [] }])
    await user.click(screen.getAllByRole('button', { name: 'New environment' })[0])
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
    expect(environments.save.mock.calls[0][0]).toMatchObject({ name: 'New environment 2' })
  })

  it('keeps the default name when the inline rename is cancelled with Escape', async () => {
    const { user, environments } = await mount()
    await user.click(screen.getByRole('button', { name: 'New environment' }))
    const list = screen.getByRole('list', { name: 'Environments' })
    const rename = await within(list).findByRole('textbox', { name: 'Name' })
    await user.type(rename, 'Changed{Escape}')
    expect(within(list).queryByRole('textbox')).toBeNull()
    expect(within(list).getByRole('button', { name: 'New environment' })).toBeInTheDocument()
    expect(environments.save).toHaveBeenCalledTimes(1)
  })

  it('commits the inline rename of a new environment on blur', async () => {
    const { user, environments } = await mount()
    await user.click(screen.getByRole('button', { name: 'New environment' }))
    const list = screen.getByRole('list', { name: 'Environments' })
    const rename = await within(list).findByRole('textbox', { name: 'Name' })
    await user.clear(rename)
    await user.type(rename, 'QA')
    await user.click(screen.getByLabelText('Variable name 1'))
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(2))
    expect(environments.save.mock.calls[1][0]).toMatchObject({ name: 'QA' })
    expect(within(list).getByRole('button', { name: 'QA' })).toBeInTheDocument()
  })

  it('reports a new environment that cannot be written, and opens nothing', async () => {
    const { user, environments } = await mount()
    environments.save.mockRejectedValueOnce(new Error('disk full'))
    await user.click(screen.getByRole('button', { name: 'New environment' }))
    await waitFor(() =>
      expect(useApp.getState().error).toMatch(/Could not create the environment "New environment": disk full/),
    )
    expect(useApp.getState().openTabs).toEqual([])
  })

  it('opens the active environment from the status bar, and Globals when none is active', async () => {
    const { user } = await mount()
    const statusBar = screen.getByRole('contentinfo')
    await user.click(within(statusBar).getByRole('button', { name: 'Environments' }))
    expect(useApp.getState().activePath).toBe('env:globals')
    await user.click(screen.getByRole('button', { name: 'Activate Dev' }))
    await user.click(within(statusBar).getByRole('button', { name: 'Environments' }))
    expect(useApp.getState().activePath).toBe('env:dev')
  })
})

describe('environment editor', () => {
  it('adds a variable by typing into the trailing row and saves it', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Dev')
    expect(rowInput('Variable name', 2)).toHaveValue('')
    await user.type(rowInput('Variable name', 2), 'token')
    await user.type(rowInput('Value', 2), 'abc')
    // A new trailing row follows the one that was typed into.
    expect(rowInput('Variable name', 3)).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
    const saved = environments.save.mock.calls[0][0] as Environment
    expect(saved.id).toBe('dev')
    expect(saved.variables).toEqual([DEV.variables[0], { key: 'token', value: 'abc', secret: false, enabled: true }])
    // Saved: the store refreshed and the form is clean again.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
    expect(useApp.getState().environments.find((e) => e.id === 'dev')?.variables).toHaveLength(2)
  })

  it('removes a variable from its row menu', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Dev')
    await rowAction(user, 1, 'Delete')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalled())
    expect((environments.save.mock.calls[0][0] as Environment).variables).toEqual([])
  })

  it('creates globals.json on the first save of Globals', async () => {
    const { user, environments } = await mount()
    await openEditor(user)
    await user.type(rowInput('Variable name'), 'region')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalled())
    expect(environments.save.mock.calls[0][0]).toMatchObject({ id: 'globals', name: 'Globals' })
  })

  it('masks secret rows, keeps the local value and saves secret: true', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Dev')
    expect(rowInput('Value')).toHaveAttribute('type', 'text')
    expect(rowInput('Value')).toHaveValue('localhost')

    await makeSecret(user)
    expect(rowInput('Value')).toHaveAttribute('type', 'password')
    expect(rowInput('Value')).toHaveValue('localhost')
    expect(screen.getByText(/shared value removed; the local value was kept/i)).toBeInTheDocument()
    // Secrets are always local: no sync control, and the type control shows the lock.
    expect(screen.queryByRole('button', { name: 'Storage of value 1' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Type 1' })).toHaveAttribute('title', 'Type: secret')

    await user.click(screen.getByRole('button', { name: 'Show value 1' }))
    expect(rowInput('Value')).toHaveAttribute('type', 'text')
    await user.click(screen.getByRole('button', { name: 'Hide value 1' }))
    expect(rowInput('Value')).toHaveAttribute('type', 'password')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalled())
    expect((environments.save.mock.calls[0][0] as Environment).variables[0]).toEqual({
      key: 'host',
      value: '',
      currentValue: 'localhost',
      secret: true,
      enabled: true,
    })
  })

  it('moves a shared value to this machine when made secret, and keeps it local when made default', async () => {
    const env: Environment = {
      id: 'e',
      name: 'E',
      variables: [{ key: 'k', value: 'shared-text', secret: false, enabled: true }],
    }
    const { user } = await mount([env])
    await openEditor(user, 'E')
    await makeSecret(user)
    expect(rowInput('Value')).toHaveValue('shared-text')
    expect(screen.getByText(/shared value now stays on this machine/i)).toBeInTheDocument()
    await makeSecret(user, 1, false)
    expect(rowInput('Value')).toHaveAttribute('type', 'text')
    expect(rowInput('Value')).toHaveValue('shared-text')
    expect(screen.getByRole('button', { name: 'Storage of value 1' })).toHaveAttribute(
      'title',
      expect.stringMatching(/^Local/),
    )
  })

  it('shows and hides every secret from the options menu', async () => {
    const env: Environment = {
      id: 'e',
      name: 'E',
      variables: [
        { key: 'a', value: '', currentValue: 'one', secret: true, enabled: true },
        { key: 'b', value: '', currentValue: 'two', secret: true, enabled: true },
        { key: 'c', value: 'plain', secret: false, enabled: true },
      ],
    }
    const { user } = await mount([env])
    await openEditor(user, 'E')
    expect(rowInput('Value', 1)).toHaveAttribute('type', 'password')
    expect(rowInput('Value', 2)).toHaveAttribute('type', 'password')
    expect(rowInput('Value', 3)).toHaveAttribute('type', 'text')
    await user.click(screen.getByRole('button', { name: 'Variable options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Show secrets' }))
    expect(rowInput('Value', 1)).toHaveAttribute('type', 'text')
    expect(rowInput('Value', 2)).toHaveAttribute('type', 'text')
    // Hiding one again turns the menu back to Show secrets.
    await user.click(screen.getByRole('button', { name: 'Hide value 2' }))
    await user.click(screen.getByRole('button', { name: 'Variable options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Show secrets' }))
    await user.click(screen.getByRole('button', { name: 'Variable options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Hide secrets' }))
    expect(rowInput('Value', 1)).toHaveAttribute('type', 'password')
    expect(rowInput('Value', 2)).toHaveAttribute('type', 'password')
  })

  it('never puts secret values into DOM attributes', async () => {
    const env: Environment = {
      id: 'e',
      name: 'E',
      variables: [{ key: 'api', value: '', currentValue: SECRET_TEXT, secret: true, enabled: true }],
    }
    const { user } = await mount([env])
    await openEditor(user, 'E')
    await user.click(screen.getByRole('button', { name: 'Show value 1' }))
    await user.type(rowInput('Value'), '-more')
    expect(rowInput('Value')).toHaveValue(`${SECRET_TEXT}-more`)
    const leaks: string[] = []
    for (const el of document.body.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) {
        if ((el.getAttribute(attr) ?? '').includes('hunter2')) leaks.push(`${el.tagName}[${attr}]`)
      }
    }
    expect(leaks).toEqual([])
  })

  describe('a secret that cannot be decrypted on this machine', () => {
    const LOCKED: Environment = {
      id: 'e',
      name: 'E',
      variables: [
        { key: 'token', value: '', secret: true, enabled: true, locked: true },
        { key: 'host', value: 'a.test', secret: false, enabled: true },
      ],
    }

    it('is shown masked and empty with an explanation, without a reveal button', async () => {
      const { user } = await mount([LOCKED])
      await openEditor(user, 'E')
      const current = rowInput('Value')
      expect(current).toHaveAttribute('type', 'password')
      expect(current).toHaveValue('')
      expect(current).toHaveAttribute('placeholder', 'Cannot decrypt on this machine')
      expect(screen.getByText(/Cannot decrypt on this machine\. Kept unless you type a new value/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Show value/ })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Variable options' }))
      await user.click(screen.getByRole('menuitem', { name: 'Show secrets' }))
      expect(current).toHaveAttribute('type', 'password')
    })

    it('is preserved when another variable is edited and saved', async () => {
      const { user, environments } = await mount([LOCKED])
      await openEditor(user, 'E')
      await user.clear(rowInput('Value', 2))
      await user.type(rowInput('Value', 2), 'b.test')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(environments.save).toHaveBeenCalled())
      expect((environments.save.mock.calls[0][0] as Environment).variables[0]).toEqual({
        key: 'token',
        value: '',
        secret: true,
        enabled: true,
        locked: true,
      })
    })

    it('is not dirty by itself, and is replaced by a typed value', async () => {
      const { user, environments } = await mount([LOCKED])
      await openEditor(user, 'E')
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
      await user.type(rowInput('Value'), 'new-secret')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(environments.save).toHaveBeenCalled())
      expect((environments.save.mock.calls[0][0] as Environment).variables[0]).toEqual({
        key: 'token',
        value: '',
        currentValue: 'new-secret',
        secret: true,
        enabled: true,
      })
    })

    it('drops the undecryptable value when the type is set back to default', async () => {
      const { user, environments } = await mount([LOCKED])
      await openEditor(user, 'E')
      await makeSecret(user, 1, false)
      expect(screen.getByText(/could not be decrypted is removed when you save/)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(environments.save).toHaveBeenCalled())
      expect((environments.save.mock.calls[0][0] as Environment).variables[0]).toEqual({
        key: 'token',
        value: '',
        secret: false,
        enabled: true,
      })
    })

    it('is not copied by Duplicate', async () => {
      const { user, environments } = await mount([LOCKED])
      await openEditor(user, 'E')
      await user.click(screen.getByRole('button', { name: 'Duplicate' }))
      await waitFor(() => expect(environments.save).toHaveBeenCalled())
      expect((environments.save.mock.calls[0][0] as Environment).variables[0]).not.toHaveProperty('locked')
    })
  })

  it('does not log anything to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m))
    const { user } = await mount()
    await openEditor(user, 'Dev')
    await makeSecret(user)
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })

  it('asks for confirmation before deleting an environment, then removes it and resets the selection', async () => {
    const { user, environments } = await mount()
    await chooseEnvironment(user, 'Dev')
    await openEditor(user, 'Dev')
    await user.click(screen.getByRole('button', { name: 'Delete environment' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(environments.remove).not.toHaveBeenCalled()
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(environments.remove).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete environment' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(environments.remove).toHaveBeenCalledWith('dev'))
    await waitFor(() => expect(useApp.getState().activeEnvironmentId).toBeNull())
    expect(useApp.getState().environments.map((e) => e.id)).toEqual(['prod'])
    expect(screen.queryByRole('button', { name: 'Dev' })).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('can neither delete nor rename Globals', async () => {
    const { user } = await mount()
    await openEditor(user)
    expect(screen.queryByRole('button', { name: 'Delete environment' })).toBeNull()
    expect(screen.queryByLabelText('Environment name')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Globals' })).toBeInTheDocument()
  })

  it('renames an environment in its header and saves the new name', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Prod')
    const name = screen.getByLabelText('Environment name')
    await user.clear(name)
    await user.type(name, 'Production')
    expect(screen.getByRole('tab', { name: /Production/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalled())
    expect(environments.save.mock.calls[0][0]).toMatchObject({ id: 'prod', name: 'Production' })
  })

  it('duplicates variables but not secret values, into a new tab', async () => {
    const env: Environment = {
      id: 'e',
      name: 'E',
      variables: [
        { key: 'host', value: 'h', currentValue: 'c', secret: false, enabled: true },
        { key: 'api', value: '', currentValue: SECRET_TEXT, secret: true, enabled: false },
      ],
    }
    const { user, environments } = await mount([env])
    await openEditor(user, 'E')
    const dup = screen.getByRole('button', { name: 'Duplicate' })
    expect(dup).toHaveAttribute('title', expect.stringMatching(/secret values are not copied/i))
    await user.click(dup)
    // Written at once, without Save.
    await waitFor(() => expect(environments.save).toHaveBeenCalled())
    const saved = environments.save.mock.calls[0][0] as Environment
    expect(saved.id).not.toBe('e')
    expect(saved.name).toBe('E copy')
    expect(saved.variables[1]).toEqual({ key: 'api', value: '', secret: true, enabled: false })
    expect(useApp.getState().openTabs).toHaveLength(2)
    expect(useApp.getState().activePath).toBe(`env:${saved.id}`)
    expect(await screen.findByLabelText('Environment name')).toHaveValue('E copy')
    expect(rowInput('Value', 1)).toHaveValue('c')
    expect(rowInput('Value', 2)).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    const rename = within(screen.getByRole('list', { name: 'Environments' })).getByRole('textbox', { name: 'Name' })
    expect(rename).toHaveValue('E copy')
    expect(rename).toHaveFocus()
  })

  it('stays with the message and the draft when saving rejects', async () => {
    const { user, environments } = await mount()
    environments.save.mockRejectedValueOnce(new Error('encryption_unavailable'))
    const panel = await openEditor(user, 'Dev')
    await user.type(rowInput('Variable name', 2), 'token')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent('encryption_unavailable')
    expect(rowInput('Variable name', 2)).toHaveValue('token')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(useApp.getState().error).toBeNull()
  })

  it('flags invalid names and disables Save', async () => {
    const { user } = await mount()
    await openEditor(user, 'Dev')
    const save = screen.getByRole('button', { name: 'Save' })

    await user.clear(rowInput('Variable name'))
    expect(rowInput('Variable name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Name is required')).toBeInTheDocument()
    expect(save).toBeDisabled()

    await user.type(rowInput('Variable name'), 'a b')
    expect(screen.getByText('Name cannot contain spaces')).toBeInTheDocument()
    expect(save).toBeDisabled()

    await user.clear(rowInput('Variable name'))
    await user.type(rowInput('Variable name'), 'a{{b')
    expect(screen.getByText('Name cannot contain { or }')).toBeInTheDocument()
    expect(save).toBeDisabled()

    await user.clear(rowInput('Variable name'))
    await user.type(rowInput('Variable name'), 'ok')
    expect(rowInput('Variable name')).not.toHaveAttribute('aria-invalid', 'true')
    expect(save).toBeEnabled()

    await user.type(rowInput('Variable name', 2), 'ok')
    expect(screen.getAllByText('Name is already used').length).toBeGreaterThan(0)
    expect(save).toBeDisabled()
    await user.type(rowInput('Variable name', 2), '2')
    expect(save).toBeEnabled()
    await user.clear(rowInput('Variable name', 2))
    await user.type(rowInput('Variable name', 2), 'OK')
    expect(save).toBeEnabled() // case-sensitive
  })

  it('requires a unique, non-empty environment name (case-insensitive)', async () => {
    const { user } = await mount()
    await openEditor(user, 'Prod')
    const name = screen.getByLabelText('Environment name')
    const save = screen.getByRole('button', { name: 'Save' })
    await user.clear(name)
    expect(screen.getByText('Name is required')).toBeInTheDocument()
    expect(save).toBeDisabled()
    await user.type(name, 'dEV')
    expect(screen.getByText('Another environment already has this name')).toBeInTheDocument()
    expect(save).toBeDisabled()
    await user.type(name, '2')
    expect(save).toBeEnabled()
  })

  it('keeps the draft while another tab is shown, and marks the tab as changed', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Dev')
    await user.type(rowInput('Value'), 'X')
    expect(screen.getByRole('tab', { name: /Dev/ })).toHaveTextContent('Unsaved changes')
    await openEditor(user, 'Prod')
    expect(screen.getByLabelText('Environment name')).toHaveValue('Prod')
    await user.click(screen.getByRole('tab', { name: /Dev/ }))
    expect(rowInput('Value')).toHaveValue('localhostX')
    expect(environments.save).not.toHaveBeenCalled()
  })

  it('saves the draft when its tab is closed', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Dev')
    await user.type(rowInput('Value'), 'X')
    await user.click(screen.getByRole('button', { name: 'Close Dev' }))
    expect(screen.queryByRole('tabpanel')).toBeNull()
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
    expect((environments.save.mock.calls[0][0] as Environment).variables[0]).toMatchObject({
      value: 'dev.example.com',
      currentValue: 'localhostX',
    })
  })

  it('asks before closing a tab whose draft cannot be saved, and keeps it on Cancel', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Dev')
    await user.clear(rowInput('Variable name'))
    await user.click(screen.getByRole('button', { name: 'Close Dev' }))
    const prompt = await screen.findByRole('alertdialog', { name: 'Unsaved changes' })
    expect(prompt).toHaveTextContent('Name is required')
    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('tabpanel')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close Dev' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Close and discard' }))
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(environments.save).not.toHaveBeenCalled()
    expect(useApp.getState().environmentDrafts).toEqual({})
  })

  it('saves with Cmd/Ctrl+S inside the editor', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Dev')
    await user.type(rowInput('Value'), 'X')
    await user.keyboard(`{${MOD}>}s{/${MOD}}`)
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
  })

  it('saves with Cmd/Ctrl+S wherever the focus is, and the browser does nothing else', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Dev')
    await user.type(rowInput('Value'), 'X')
    // Focus in the header search, outside the editor.
    await user.click(screen.getByRole('combobox', { name: 'Search requests' }))
    const event = new KeyboardEvent('keydown', {
      key: 's',
      [IS_MAC ? 'metaKey' : 'ctrlKey']: true,
      bubbles: true,
      cancelable: true,
    })
    screen.getByRole('combobox', { name: 'Search requests' }).dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
    expect(environments.save.mock.calls[0][0]).toMatchObject({ id: 'dev' })
  })

  it('saves with Cmd/Ctrl+S even from an input that stops the key (inline rename)', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Dev')
    await user.type(rowInput('Value'), 'Y')
    await user.click(screen.getByRole('button', { name: 'Actions for Prod' }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const rename = within(screen.getByRole('list', { name: 'Environments' })).getByRole('textbox', { name: 'Name' })
    expect(rename).toHaveFocus()
    await user.keyboard(`{${MOD}>}s{/${MOD}}`)
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
    expect(environments.save.mock.calls[0][0]).toMatchObject({ id: 'dev' })
  })

  it("offers the request's variables in the URL, header and auth fields when {{ is typed", async () => {
    const globals: Environment = {
      id: 'globals',
      name: 'Globals',
      variables: [
        { key: 'host', value: 'global.example', secret: false, enabled: true },
        { key: 'apiKey', value: '', currentValue: SECRET_TEXT, secret: true, enabled: true },
      ],
    }
    const { user } = await mount([DEV, PROD, globals])
    await chooseEnvironment(user, 'Dev')
    useApp.getState().openRequest(REQUEST_PATH)
    const url = await screen.findByRole('textbox', { name: 'URL' })
    await user.type(url, '{{{{')
    const options = within(screen.getByRole('listbox', { name: 'Variables' })).getAllByRole('option')
    // The environment's host wins over the globals' one, as when sending; secrets are masked.
    expect(options.map((o) => o.textContent)).toEqual(['hostlocalhostEnvironment', 'apiKey••••Globals'])
    await user.keyboard('{Enter}')
    expect(url).toHaveValue('{{host}}')
  })

  it('disables the form while saving', async () => {
    let finish!: () => void
    const { user, environments } = await mount()
    environments.save.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)))
    await openEditor(user, 'Dev')
    await user.type(rowInput('Value'), 'X')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(rowInput('Value')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    finish()
    await waitFor(() => expect(rowInput('Value')).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('applies a save that finishes after switching to another tab', async () => {
    let finish!: () => void
    const { user, environments, disk } = await mount()
    environments.save.mockImplementationOnce(async (env: Environment) => {
      await new Promise<void>((r) => (finish = r))
      disk.envs[0] = structuredClone(env)
    })
    await openEditor(user, 'Dev')
    await user.type(rowInput('Value'), 'X')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await openEditor(user, 'Prod')
    finish()
    await waitFor(() => expect(useApp.getState().environments[0].variables[0].currentValue).toBe('localhostX'))
    await user.click(screen.getByRole('tab', { name: /Dev/ }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.queryByText('Changed on disk')).toBeNull()
  })

  it('keeps the draft and shows Changed on disk when the environment changed meanwhile', async () => {
    const { user, disk } = await mount()
    await openEditor(user, 'Dev')
    await user.type(rowInput('Value'), 'X')
    disk.envs[0] = { ...DEV, variables: [{ ...DEV.variables[0], value: 'other' }] }
    await useApp.getState().refresh()
    expect(await screen.findByText('Changed on disk')).toBeInTheDocument()
    expect(rowInput('Value')).toHaveValue('localhostX')
  })

  it('adopts changes from disk while the draft is clean', async () => {
    const { user, disk } = await mount()
    await openEditor(user, 'Dev')
    disk.envs[0] = { ...DEV, variables: [{ ...DEV.variables[0], currentValue: 'other' }] }
    await useApp.getState().refresh()
    await waitFor(() => expect(rowInput('Value')).toHaveValue('other'))
    expect(screen.queryByText('Changed on disk')).toBeNull()
  })

  it('shows an error and keeps the draft when the environment was deleted on disk', async () => {
    const { user, disk } = await mount()
    const panel = await openEditor(user, 'Dev')
    await user.type(rowInput('Value'), 'X')
    disk.envs = disk.envs.filter((e) => e.id !== 'dev')
    await useApp.getState().refresh()
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/deleted on disk/i)
    expect(rowInput('Value')).toHaveValue('localhostX')
  })

  it('closes a clean editor of an environment deleted on disk', async () => {
    const { user, disk } = await mount()
    await openEditor(user, 'Dev')
    disk.envs = disk.envs.filter((e) => e.id !== 'dev')
    await useApp.getState().refresh()
    await waitFor(() => expect(screen.queryByRole('tabpanel')).toBeNull())
  })

  it('shows environment load errors with the file path while healthy ones stay usable', async () => {
    const disk: Disk = { envs: [DEV], errors: [{ path: 'environments/broken.json', message: 'Invalid environment' }] }
    const api = installApi({ environments: diskApi(disk) })
    const user = userEvent.setup()
    await useApp.getState().openWorkspace('/tmp/demo')
    render(<App />)
    const panel = await openEditor(user, 'Dev')
    expect(within(panel).getByText(/environments\/broken\.json/)).toBeInTheDocument()
    expect(within(panel).getByText(/Invalid environment/)).toBeInTheDocument()
    expect(rowInput('Variable name')).toHaveValue('host')
    expect(api.environments.list).toHaveBeenCalled()
  })

  it('explains where initial and current values are kept, in the options menu', async () => {
    const { user } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Variable options' }))
    expect(
      screen.getByText(
        'Initial values are saved in the workspace folder and synced with git. Current values and secrets stay on this machine.',
      ),
    ).toBeInTheDocument()
  })
})

describe('two-column variables', () => {
  const MIXED: Environment = {
    id: 'm',
    name: 'Mixed',
    variables: [
      { key: 'shared', value: 's-init', secret: false, enabled: true },
      { key: 'local', value: 'l-init', currentValue: 'l-cur', secret: false, enabled: true },
      { key: 'same', value: 'eq', currentValue: 'eq', secret: false, enabled: true },
      { key: 'onlyLocal', value: '', currentValue: 'mine', secret: false, enabled: true },
    ],
  }

  async function saved(user: ReturnType<typeof userEvent.setup>, environments: ReturnType<typeof diskApi>) {
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalled())
    return (environments.save.mock.calls.at(-1)![0] as Environment).variables
  }

  function storage(n: number): string | null {
    return screen.getByRole('button', { name: `Storage of value ${n}` }).getAttribute('title')
  }

  it('shows the effective value: the current one when set, otherwise the initial one', async () => {
    const { user } = await mount([MIXED])
    await openEditor(user, 'Mixed')
    expect(rowInput('Value', 1)).toHaveValue('s-init')
    expect(rowInput('Value', 2)).toHaveValue('l-cur')
    expect(rowInput('Value', 3)).toHaveValue('eq')
    expect(rowInput('Value', 4)).toHaveValue('mine')
    expect(storage(1)).toMatch(/^Shared/)
    expect(storage(2)).toMatch(/^Local/)
    // A current value equal to the initial one counts as shared.
    expect(storage(3)).toMatch(/^Shared/)
    expect(storage(4)).toMatch(/^Local/)
  })

  it('writes the initial value of a shared row and the current value of a local row', async () => {
    const { user, environments } = await mount([MIXED])
    await openEditor(user, 'Mixed')
    await user.type(rowInput('Value', 1), '!')
    await user.type(rowInput('Value', 2), '!')
    await user.type(rowInput('Value', 3), '!')
    const vars = await saved(user, environments)
    expect(vars[0]).toEqual({ key: 'shared', value: 's-init!', secret: false, enabled: true })
    expect(vars[1]).toEqual({ key: 'local', value: 'l-init', currentValue: 'l-cur!', secret: false, enabled: true })
    // Shared with an equal current value: the initial value is written and the current one dropped.
    expect(vars[2]).toEqual({ key: 'same', value: 'eq!', secret: false, enabled: true })
  })

  it('keeps writing the local side while the typed value passes through the initial one', async () => {
    const env: Environment = {
      id: 'e',
      name: 'E',
      variables: [{ key: 'k', value: 'ab', currentValue: 'a', secret: false, enabled: true }],
    }
    const { user, environments } = await mount([env])
    await openEditor(user, 'E')
    await user.type(rowInput('Value'), 'bc')
    expect(rowInput('Value')).toHaveValue('abc')
    expect((await saved(user, environments))[0]).toEqual({
      key: 'k',
      value: 'ab',
      currentValue: 'abc',
      secret: false,
      enabled: true,
    })
  })

  it('switches a local row to shared: the shown value becomes the initial value', async () => {
    const { user, environments } = await mount([MIXED])
    await openEditor(user, 'Mixed')
    await setStorage(user, 2, 'Shared')
    expect(rowInput('Value', 2)).toHaveValue('l-cur')
    expect(storage(2)).toMatch(/^Shared/)
    expect((await saved(user, environments))[1]).toEqual({
      key: 'local',
      value: 'l-cur',
      secret: false,
      enabled: true,
    })
  })

  it('switches a shared row to local and keeps the initial value, shown in the menu', async () => {
    const { user, environments } = await mount([MIXED])
    await openEditor(user, 'Mixed')
    await setStorage(user, 1, 'Local')
    expect(storage(1)).toMatch(/^Local/)
    await user.clear(rowInput('Value', 1))
    await user.type(rowInput('Value', 1), 'mine')
    await user.click(screen.getByRole('button', { name: 'Storage of value 1' }))
    const menu = screen.getByRole('menu', { name: 'Where the value is kept' })
    expect(within(menu).getByRole('menuitemradio', { name: /^Local: only on this machine/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(menu).getByText('Shared value: s-init')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect((await saved(user, environments))[0]).toEqual({
      key: 'shared',
      value: 's-init',
      currentValue: 'mine',
      secret: false,
      enabled: true,
    })
  })

  it('does not show a shared value in the menu when the initial value is empty', async () => {
    const { user } = await mount([MIXED])
    await openEditor(user, 'Mixed')
    await user.click(screen.getByRole('button', { name: 'Storage of value 4' }))
    expect(screen.queryByText(/^Shared value:/)).toBeNull()
  })

  it('starts a new variable shared, and leaves its initial value empty when switched to local', async () => {
    const { user, environments } = await mount([MIXED])
    await openEditor(user, 'Mixed')
    await user.type(rowInput('Variable name', 5), 'fresh')
    expect(rowInput('Variable name', 5)).toHaveFocus()
    await user.type(rowInput('Value', 5), 'v1')
    expect(storage(5)).toMatch(/^Shared/)
    await setStorage(user, 5, 'Local')
    expect(rowInput('Value', 5)).toHaveValue('v1')
    expect((await saved(user, environments))[4]).toEqual({
      key: 'fresh',
      value: '',
      currentValue: 'v1',
      secret: false,
      enabled: true,
    })
  })

  it('keeps the focus in the value cell when typing into the trailing row creates a variable', async () => {
    const { user } = await mount([MIXED])
    await openEditor(user, 'Mixed')
    await user.type(rowInput('Value', 5), 'xyz')
    expect(rowInput('Value', 5)).toHaveFocus()
    expect(rowInput('Value', 5)).toHaveValue('xyz')
    expect(rowInput('Variable name', 6)).toHaveAttribute('placeholder', 'Add variable')
  })

  it('filters the rows by name with the search', async () => {
    const { user } = await mount([MIXED])
    await openEditor(user, 'Mixed')
    await user.click(screen.getByRole('button', { name: 'Search variables' }))
    const filter = screen.getByRole('searchbox', { name: 'Filter variables' })
    expect(filter).toHaveFocus()
    await user.type(filter, 'LOCAL')
    const names = screen.getAllByRole('textbox', { name: /^Variable name/ }) as HTMLInputElement[]
    expect(names.map((i) => i.value)).toEqual(['local', 'onlyLocal'])
    // The numbering follows the whole list, and the Add variable row is hidden while filtering.
    expect(rowInput('Variable name', 2)).toHaveValue('local')
    expect(screen.queryByLabelText('Variable name 5')).toBeNull()
    await user.clear(filter)
    await user.type(filter, 'nothing')
    expect(screen.getByText(/No variables match/)).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('searchbox', { name: 'Filter variables' })).toBeNull()
    expect(screen.getAllByRole('textbox', { name: /^Variable name/ })).toHaveLength(5)
  })

  it('disables and enables a variable from its row menu, with muted text', async () => {
    const { user, environments } = await mount([MIXED])
    await openEditor(user, 'Mixed')
    await rowAction(user, 1, 'Disable')
    expect(rowInput('Variable name', 1).closest('tr')).toHaveClass('grid-disabled')
    expect((await saved(user, environments))[0]).toMatchObject({ key: 'shared', enabled: false })
    await rowAction(user, 1, 'Enable')
    expect(rowInput('Variable name', 1).closest('tr')).not.toHaveClass('grid-disabled')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    expect((await saved(user, environments))[0]).toMatchObject({ key: 'shared', enabled: true })
  })

  it('round-trips a disabled variable untouched', async () => {
    const env: Environment = {
      id: 'e',
      name: 'E',
      variables: [
        { key: 'off', value: 'x', secret: false, enabled: false },
        { key: 'on', value: 'y', secret: false, enabled: true },
      ],
    }
    const { user, environments } = await mount([env])
    await openEditor(user, 'E')
    expect(rowInput('Variable name', 1).closest('tr')).toHaveClass('grid-disabled')
    await user.type(rowInput('Value', 2), '2')
    expect((await saved(user, environments))[0]).toEqual(env.variables[0])
  })

  it('duplicates a row under it with a free name', async () => {
    const { user, environments } = await mount([MIXED])
    await openEditor(user, 'Mixed')
    await rowAction(user, 2, 'Duplicate row')
    expect(rowInput('Variable name', 3)).toHaveValue('local_copy')
    expect(rowInput('Value', 3)).toHaveValue('l-cur')
    await rowAction(user, 2, 'Duplicate row')
    expect(rowInput('Variable name', 3)).toHaveValue('local_copy2')
    const vars = await saved(user, environments)
    expect(vars.map((v) => v.key)).toEqual(['shared', 'local', 'local_copy2', 'local_copy', 'same', 'onlyLocal'])
    expect(vars[3]).toEqual({ key: 'local_copy', value: 'l-init', currentValue: 'l-cur', secret: false, enabled: true })
  })

  it('switches the type through the type control', async () => {
    const { user } = await mount([MIXED])
    await openEditor(user, 'Mixed')
    await user.click(screen.getByRole('button', { name: 'Type 1' }))
    expect(screen.getByRole('menuitemradio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('menuitemradio', { name: 'Secret' }))
    expect(rowInput('Value', 1)).toHaveAttribute('type', 'password')
    expect(rowInput('Value', 1)).toHaveValue('s-init')
  })

  describe('a renamed secret that cannot be decrypted', () => {
    const LOCKED: Environment = {
      id: 'e',
      name: 'E',
      variables: [{ key: 'token', value: '', secret: true, enabled: true, locked: true }],
    }

    it('tells the store where its value is kept, and is not dirty after the save', async () => {
      const { user, environments } = await mount([LOCKED])
      await openEditor(user, 'E')
      await user.clear(rowInput('Variable name'))
      await user.type(rowInput('Variable name'), 'apiToken')
      expect((await saved(user, environments))[0]).toEqual({
        key: 'apiToken',
        value: '',
        secret: true,
        enabled: true,
        locked: true,
        lockedKey: 'token',
      })
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
      expect(screen.queryByText('Changed on disk')).toBeNull()
    })

    it('points the next save at the new key', async () => {
      const { user, environments, disk } = await mount([LOCKED])
      // Like the real store: a listed locked secret comes back without the bookkeeping field.
      environments.save.mockImplementation(async (env: Environment) => {
        disk.envs[0] = { ...env, variables: env.variables.map(({ lockedKey: _k, ...v }) => v) }
      })
      await openEditor(user, 'E')
      await user.clear(rowInput('Variable name'))
      await user.type(rowInput('Variable name'), 'apiToken')
      await saved(user, environments)
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
      await user.type(rowInput('Variable name', 2), 'other')
      expect((await saved(user, environments))[0]).toEqual({
        key: 'apiToken',
        value: '',
        secret: true,
        enabled: true,
        locked: true,
      })
    })
  })
})

describe('environment store actions', () => {
  it('does not apply a save result after the workspace was replaced', async () => {
    let finish!: () => void
    const { environments } = await mount()
    environments.save.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)))
    const pending = useApp.getState().saveEnvironment(PROD)
    await useApp.getState().openWorkspace('/tmp/other')
    const listCalls = environments.list.mock.calls.length
    finish()
    await expect(pending).resolves.toBe(false)
    expect(environments.list.mock.calls.length).toBe(listCalls)
  })
})
