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
  await user.selectOptions(screen.getByLabelText(`Type ${n}`), secret ? 'secret' : 'default')
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

  it('creates a new environment from the section header', async () => {
    const { user, environments } = await mount()
    await user.click(screen.getByRole('button', { name: 'New environment' }))
    expect(screen.getByLabelText('Environment name')).toHaveValue('New environment')
    expect(screen.getByText('Not saved yet')).toBeInTheDocument()
    await user.type(rowInput('Variable name'), 'k')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
    expect(environments.save.mock.calls[0][0]).toMatchObject({ name: 'New environment', variables: [{ key: 'k' }] })
    await waitFor(() => expect(screen.queryByText('Not saved yet')).toBeNull())
    expect(within(screen.getByRole('list', { name: 'Environments' })).getByRole('button', { name: 'New environment' }))
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
    await user.type(rowInput('Initial value', 2), 'abc')
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

  it('removes a variable with its trash button', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Dev')
    await user.click(screen.getByRole('button', { name: 'Delete variable 1' }))
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

  it('masks secret rows, moves the initial value into the current value and saves secret: true', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Dev')
    expect(rowInput('Initial value')).toHaveAttribute('type', 'text')

    await makeSecret(user)
    expect(rowInput('Initial value')).toHaveAttribute('type', 'password')
    expect(rowInput('Current value')).toHaveAttribute('type', 'password')
    expect(rowInput('Initial value')).toBeDisabled()
    expect(rowInput('Initial value')).toHaveValue('')
    expect(rowInput('Initial value')).toHaveAttribute('placeholder', 'Secrets are never shared')
    expect(rowInput('Current value')).toHaveValue('localhost')

    await user.click(screen.getByRole('button', { name: 'Show value' }))
    expect(rowInput('Current value')).toHaveAttribute('type', 'text')
    await user.click(screen.getByRole('button', { name: 'Hide value' }))
    expect(rowInput('Current value')).toHaveAttribute('type', 'password')

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

  it('tells where the initial value went when made secret, and keeps the current value when made default', async () => {
    const env: Environment = {
      id: 'e',
      name: 'E',
      variables: [{ key: 'k', value: 'shared-text', secret: false, enabled: true }],
    }
    const { user } = await mount([env])
    await openEditor(user, 'E')
    await makeSecret(user)
    expect(rowInput('Current value')).toHaveValue('shared-text')
    expect(screen.getByText(/moved to the current value/i)).toBeInTheDocument()
    await makeSecret(user, 1, false)
    expect(rowInput('Initial value')).toBeEnabled()
    expect(rowInput('Initial value')).toHaveValue('')
    expect(rowInput('Current value')).toHaveValue('shared-text')
  })

  it('never puts secret values into DOM attributes', async () => {
    const env: Environment = {
      id: 'e',
      name: 'E',
      variables: [{ key: 'api', value: '', currentValue: SECRET_TEXT, secret: true, enabled: true }],
    }
    const { user } = await mount([env])
    await openEditor(user, 'E')
    await user.click(screen.getByRole('button', { name: 'Show value' }))
    await user.type(rowInput('Current value'), '-more')
    expect(rowInput('Current value')).toHaveValue(`${SECRET_TEXT}-more`)
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
      const current = rowInput('Current value')
      expect(current).toHaveAttribute('type', 'password')
      expect(current).toHaveValue('')
      expect(current).toHaveAttribute('placeholder', 'Cannot decrypt on this machine')
      expect(screen.getByText(/Cannot decrypt on this machine\. Kept unless you type a new value/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Show value' })).not.toBeInTheDocument()
    })

    it('is preserved when another variable is edited and saved', async () => {
      const { user, environments } = await mount([LOCKED])
      await openEditor(user, 'E')
      await user.clear(rowInput('Initial value', 2))
      await user.type(rowInput('Initial value', 2), 'b.test')
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
      await user.type(rowInput('Current value'), 'new-secret')
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
      await user.click(screen.getByRole('button', { name: 'Save' }))
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
    expect(useApp.getState().openTabs).toHaveLength(2)
    expect(screen.getByLabelText('Environment name')).toHaveValue('E copy')
    expect(rowInput('Current value', 1)).toHaveValue('c')
    expect(rowInput('Current value', 2)).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalled())
    const saved = environments.save.mock.calls[0][0] as Environment
    expect(saved.id).not.toBe('e')
    expect(saved.name).toBe('E copy')
    expect(saved.variables[1]).toEqual({ key: 'api', value: '', secret: true, enabled: false })
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
    await user.type(rowInput('Initial value'), 'X')
    expect(screen.getByRole('tab', { name: /Dev/ })).toHaveTextContent('Unsaved changes')
    await openEditor(user, 'Prod')
    expect(screen.getByLabelText('Environment name')).toHaveValue('Prod')
    await user.click(screen.getByRole('tab', { name: /Dev/ }))
    expect(rowInput('Initial value')).toHaveValue('dev.example.comX')
    expect(environments.save).not.toHaveBeenCalled()
  })

  it('saves the draft when its tab is closed', async () => {
    const { user, environments } = await mount()
    await openEditor(user, 'Dev')
    await user.type(rowInput('Initial value'), 'X')
    await user.click(screen.getByRole('button', { name: 'Close Dev' }))
    expect(screen.queryByRole('tabpanel')).toBeNull()
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
    expect((environments.save.mock.calls[0][0] as Environment).variables[0].value).toBe('dev.example.comX')
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
    await user.type(rowInput('Initial value'), 'X')
    await user.keyboard(`{${MOD}>}s{/${MOD}}`)
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
  })

  it('disables the form while saving', async () => {
    let finish!: () => void
    const { user, environments } = await mount()
    environments.save.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)))
    await openEditor(user, 'Dev')
    await user.type(rowInput('Initial value'), 'X')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(rowInput('Initial value')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    finish()
    await waitFor(() => expect(rowInput('Initial value')).toBeEnabled())
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
    await user.type(rowInput('Initial value'), 'X')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await openEditor(user, 'Prod')
    finish()
    await waitFor(() => expect(useApp.getState().environments[0].variables[0].value).toBe('dev.example.comX'))
    await user.click(screen.getByRole('tab', { name: /Dev/ }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.queryByText('Changed on disk')).toBeNull()
  })

  it('keeps the draft and shows Changed on disk when the environment changed meanwhile', async () => {
    const { user, disk } = await mount()
    await openEditor(user, 'Dev')
    await user.type(rowInput('Initial value'), 'X')
    disk.envs[0] = { ...DEV, variables: [{ ...DEV.variables[0], value: 'other' }] }
    await useApp.getState().refresh()
    expect(await screen.findByText('Changed on disk')).toBeInTheDocument()
    expect(rowInput('Initial value')).toHaveValue('dev.example.comX')
  })

  it('adopts changes from disk while the draft is clean', async () => {
    const { user, disk } = await mount()
    await openEditor(user, 'Dev')
    disk.envs[0] = { ...DEV, variables: [{ ...DEV.variables[0], value: 'other' }] }
    await useApp.getState().refresh()
    await waitFor(() => expect(rowInput('Initial value')).toHaveValue('other'))
    expect(screen.queryByText('Changed on disk')).toBeNull()
  })

  it('shows an error and keeps the draft when the environment was deleted on disk', async () => {
    const { user, disk } = await mount()
    const panel = await openEditor(user, 'Dev')
    await user.type(rowInput('Initial value'), 'X')
    disk.envs = disk.envs.filter((e) => e.id !== 'dev')
    await useApp.getState().refresh()
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/deleted on disk/i)
    expect(rowInput('Initial value')).toHaveValue('dev.example.comX')
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

  it('explains where initial and current values are kept', async () => {
    const { user } = await mount()
    await openEditor(user)
    expect(
      screen.getByText(
        'Initial values are saved in the workspace folder and synced with git. Current values and secrets stay on this machine.',
      ),
    ).toBeInTheDocument()
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
