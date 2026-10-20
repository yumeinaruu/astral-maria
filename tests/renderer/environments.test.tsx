// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
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

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Manage environments' }))
  return screen.findByRole('dialog', { name: 'Environments' })
}

function rowInput(label: string, n = 1): HTMLInputElement {
  return screen.getByLabelText(`${label} ${n}`) as HTMLInputElement
}

beforeEach(() => {
  useApp.setState(initialState())
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('environment selector', () => {
  it('lists No environment and the non-globals environments, and selects one', async () => {
    const { user } = await mount([DEV, PROD, { id: 'globals', name: 'Globals', variables: [] }])
    const select = screen.getByRole('combobox', { name: 'Environment' })
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['No environment', 'Dev', 'Prod'])
    await user.selectOptions(select, 'Dev')
    expect(useApp.getState().activeEnvironmentId).toBe('dev')
    expect(select).toHaveValue('dev')
  })

  it('makes the next send use the selected environment id, and null for No environment', async () => {
    const result: SendResult = { ok: false, error: { code: 'x', message: 'y' } }
    const send = vi.fn().mockResolvedValue(result)
    const { user } = await mount([DEV, PROD], { http: { send } })
    useApp.getState().openRequest(REQUEST_PATH)
    const select = screen.getByRole('combobox', { name: 'Environment' })

    await user.selectOptions(select, 'Dev')
    await user.click(await screen.findByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][1]).toEqual({ collectionPath: 'collections/shop', environmentId: 'dev' })

    await user.selectOptions(select, 'No environment')
    await user.click(await screen.findByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1][1]).toEqual({ collectionPath: 'collections/shop', environmentId: null })
  })

  it('resets the selection with a notice when the active environment disappears after a refresh', async () => {
    const { user, disk } = await mount()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Environment' }), 'Dev')
    disk.envs = disk.envs.filter((e) => e.id !== 'dev')
    await useApp.getState().refresh()
    expect(useApp.getState().activeEnvironmentId).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveValue('')
    expect(await screen.findByRole('status')).toHaveTextContent('Dev')
    await user.click(screen.getByRole('button', { name: 'Dismiss notice' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('environment editor', () => {
  it('lists Globals first even when globals.json does not exist yet', async () => {
    const { user } = await mount()
    const dialog = await openEditor(user)
    const names = within(within(dialog).getByRole('list', { name: 'Environments' }))
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(names).toEqual(['Globals', 'Dev', 'Prod'])
  })

  it('adds a variable and saves it', async () => {
    const { user, environments } = await mount()
    const dialog = await openEditor(user)
    await user.click(within(dialog).getByRole('button', { name: 'Dev' }))
    await user.click(screen.getByRole('button', { name: 'Add variable' }))
    await user.type(rowInput('Variable name', 2), 'token')
    await user.type(rowInput('Shared value', 2), 'abc')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
    const saved = environments.save.mock.calls[0][0] as Environment
    expect(saved.id).toBe('dev')
    expect(saved.variables).toEqual([DEV.variables[0], { key: 'token', value: 'abc', secret: false, enabled: true }])
    // Saved: the store refreshed and the form is clean again.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
    expect(useApp.getState().environments.find((e) => e.id === 'dev')?.variables).toHaveLength(2)
  })

  it('ignores blank trailing rows on save', async () => {
    const { user, environments } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Prod' }))
    await user.click(screen.getByRole('button', { name: 'Add variable' }))
    await user.type(screen.getByLabelText('Environment name'), '2')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalled())
    expect((environments.save.mock.calls[0][0] as Environment).variables).toEqual([])
  })

  it('creates a new environment on first save of Globals', async () => {
    const { user, environments } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Add variable' }))
    await user.type(rowInput('Variable name'), 'region')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalled())
    expect(environments.save.mock.calls[0][0]).toMatchObject({ id: 'globals', name: 'Globals' })
  })

  it('masks secret rows, moves shared text into the current value and saves secret: true', async () => {
    const { user, environments } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Dev' }))
    expect(rowInput('Shared value')).toHaveAttribute('type', 'text')

    await user.click(rowInput('Secret'))
    expect(rowInput('Shared value')).toHaveAttribute('type', 'password')
    expect(rowInput('Current value')).toHaveAttribute('type', 'password')
    expect(rowInput('Shared value')).toBeDisabled()
    expect(rowInput('Shared value')).toHaveValue('')
    expect(rowInput('Current value')).toHaveValue('localhost')
    expect(screen.getByText('Secrets are never shared')).toBeInTheDocument()

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

  it('tells where the shared text went when Secret is ticked, and keeps the current value when unticked', async () => {
    const env: Environment = {
      id: 'e',
      name: 'E',
      variables: [{ key: 'k', value: 'shared-text', secret: false, enabled: true }],
    }
    const { user } = await mount([env])
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'E' }))
    await user.click(rowInput('Secret'))
    expect(rowInput('Current value')).toHaveValue('shared-text')
    expect(screen.getByText(/moved to the current value/i)).toBeInTheDocument()
    await user.click(rowInput('Secret'))
    expect(rowInput('Shared value')).toBeEnabled()
    expect(rowInput('Shared value')).toHaveValue('')
    expect(rowInput('Current value')).toHaveValue('shared-text')
  })

  it('never puts secret values into DOM attributes', async () => {
    const env: Environment = {
      id: 'e',
      name: 'E',
      variables: [{ key: 'api', value: '', currentValue: SECRET_TEXT, secret: true, enabled: true }],
    }
    const { user } = await mount([env])
    const dialog = await openEditor(user)
    await user.click(within(dialog).getByRole('button', { name: 'E' }))
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
      const dialog = await openEditor(user)
      await user.click(within(dialog).getByRole('button', { name: 'E' }))
      const current = rowInput('Current value')
      expect(current).toHaveAttribute('type', 'password')
      expect(current).toHaveValue('')
      expect(current).toHaveAttribute('placeholder', 'Cannot decrypt on this machine')
      expect(screen.getByText(/Cannot decrypt on this machine\. Kept unless you type a new value/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Show value' })).not.toBeInTheDocument()
    })

    it('is preserved when another variable is edited and saved', async () => {
      const { user, environments } = await mount([LOCKED])
      const dialog = await openEditor(user)
      await user.click(within(dialog).getByRole('button', { name: 'E' }))
      await user.clear(rowInput('Shared value', 2))
      await user.type(rowInput('Shared value', 2), 'b.test')
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
      const dialog = await openEditor(user)
      await user.click(within(dialog).getByRole('button', { name: 'E' }))
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

    it('drops the undecryptable value when Secret is unticked', async () => {
      const { user, environments } = await mount([LOCKED])
      const dialog = await openEditor(user)
      await user.click(within(dialog).getByRole('button', { name: 'E' }))
      await user.click(rowInput('Secret'))
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
      const dialog = await openEditor(user)
      await user.click(within(dialog).getByRole('button', { name: 'E' }))
      await user.click(screen.getByRole('button', { name: 'Duplicate' }))
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(environments.save).toHaveBeenCalled())
      expect((environments.save.mock.calls[0][0] as Environment).variables[0]).not.toHaveProperty('locked')
    })
  })

  it('does not log anything to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m))
    const { user } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Dev' }))
    await user.click(rowInput('Secret'))
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })

  it('asks for confirmation before deleting an environment, then removes it and resets the selection', async () => {
    const { user, environments } = await mount()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Environment' }), 'Dev')
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Dev' }))
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
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('can neither delete nor rename Globals', async () => {
    const { user } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Globals' }))
    expect(screen.queryByRole('button', { name: 'Delete environment' })).toBeNull()
    expect(screen.queryByLabelText('Environment name')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Globals' })).toBeInTheDocument()
  })

  it('renames an environment inline and saves the new name', async () => {
    const { user, environments } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Prod' }))
    const name = screen.getByLabelText('Environment name')
    await user.clear(name)
    await user.type(name, 'Production')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalled())
    expect(environments.save.mock.calls[0][0]).toMatchObject({ id: 'prod', name: 'Production' })
  })

  it('duplicates variables but not secret values', async () => {
    const env: Environment = {
      id: 'e',
      name: 'E',
      variables: [
        { key: 'host', value: 'h', currentValue: 'c', secret: false, enabled: true },
        { key: 'api', value: '', currentValue: SECRET_TEXT, secret: true, enabled: false },
      ],
    }
    const { user, environments } = await mount([env])
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'E' }))
    const dup = screen.getByRole('button', { name: 'Duplicate' })
    expect(dup).toHaveAttribute('title', expect.stringMatching(/secret values are not copied/i))
    await user.click(dup)
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

  it('stays open with the message and the draft when saving rejects', async () => {
    const { user, environments } = await mount()
    environments.save.mockRejectedValueOnce(new Error('encryption_unavailable'))
    const dialog = await openEditor(user)
    await user.click(within(dialog).getByRole('button', { name: 'Dev' }))
    await user.click(screen.getByRole('button', { name: 'Add variable' }))
    await user.type(rowInput('Variable name', 2), 'token')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('encryption_unavailable')
    expect(dialog).toBeInTheDocument()
    expect(rowInput('Variable name', 2)).toHaveValue('token')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(useApp.getState().error).toBeNull()
  })

  it('flags invalid names and disables Save', async () => {
    const { user } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Dev' }))
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

    await user.click(screen.getByRole('button', { name: 'Add variable' }))
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
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Prod' }))
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

  it('asks Save / Discard / Cancel when switching with unsaved changes', async () => {
    const { user, environments } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Dev' }))
    await user.type(rowInput('Shared value'), 'X')

    await user.click(screen.getByRole('button', { name: 'Prod' }))
    let prompt = await screen.findByRole('alertdialog', { name: 'Unsaved changes' })
    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(rowInput('Shared value')).toHaveValue('dev.example.comX')

    await user.click(screen.getByRole('button', { name: 'Prod' }))
    prompt = await screen.findByRole('alertdialog', { name: 'Unsaved changes' })
    await user.click(within(prompt).getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByLabelText('Environment name')).toHaveValue('Prod')
    expect(environments.save).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Dev' }))
    expect(rowInput('Shared value')).toHaveValue('dev.example.com')

    await user.type(rowInput('Shared value'), 'Y')
    await user.click(screen.getByRole('button', { name: 'Prod' }))
    prompt = await screen.findByRole('alertdialog', { name: 'Unsaved changes' })
    await user.click(within(prompt).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
    expect(environments.save.mock.calls[0][0]).toMatchObject({ id: 'dev' })
    await waitFor(() => expect(screen.getByLabelText('Environment name')).toHaveValue('Prod'))
  })

  it('asks before closing with unsaved changes, Escape closes a clean dialog and focus returns', async () => {
    const { user } = await mount()
    const gear = screen.getByRole('button', { name: 'Manage environments' })
    await openEditor(user)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(gear).toHaveFocus()

    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Dev' }))
    await user.type(rowInput('Shared value'), 'X')
    await user.keyboard('{Escape}')
    const prompt = await screen.findByRole('alertdialog', { name: 'Unsaved changes' })
    await user.click(within(prompt).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('saves with Ctrl+S inside the dialog', async () => {
    const { user, environments } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Dev' }))
    await user.type(rowInput('Shared value'), 'X')
    await user.keyboard('{Control>}s{/Control}')
    await waitFor(() => expect(environments.save).toHaveBeenCalledTimes(1))
  })

  it('disables the form while saving and ignores the result for a later selection', async () => {
    let finish!: () => void
    const { user, environments } = await mount()
    environments.save.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)))
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Dev' }))
    await user.type(rowInput('Shared value'), 'X')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(rowInput('Shared value')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Prod' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    finish()
    await waitFor(() => expect(rowInput('Shared value')).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Prod' }))
    expect(screen.getByLabelText('Environment name')).toHaveValue('Prod')
  })

  it('keeps the draft and shows Changed on disk when the environment changed meanwhile', async () => {
    const { user, disk } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Dev' }))
    await user.type(rowInput('Shared value'), 'X')
    disk.envs[0] = { ...DEV, variables: [{ ...DEV.variables[0], value: 'other' }] }
    await useApp.getState().refresh()
    expect(await screen.findByText('Changed on disk')).toBeInTheDocument()
    expect(rowInput('Shared value')).toHaveValue('dev.example.comX')
  })

  it('adopts changes from disk while the draft is clean', async () => {
    const { user, disk } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Dev' }))
    disk.envs[0] = { ...DEV, variables: [{ ...DEV.variables[0], value: 'other' }] }
    await useApp.getState().refresh()
    await waitFor(() => expect(rowInput('Shared value')).toHaveValue('other'))
    expect(screen.queryByText('Changed on disk')).toBeNull()
  })

  it('shows an error and keeps the draft when the environment was deleted on disk', async () => {
    const { user, disk } = await mount()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Dev' }))
    await user.type(rowInput('Shared value'), 'X')
    disk.envs = disk.envs.filter((e) => e.id !== 'dev')
    await useApp.getState().refresh()
    expect(await screen.findByRole('alert')).toHaveTextContent(/deleted on disk/i)
    expect(rowInput('Shared value')).toHaveValue('dev.example.comX')
  })

  it('shows environment load errors with the file path while healthy ones stay usable', async () => {
    const disk: Disk = { envs: [DEV], errors: [{ path: 'environments/broken.json', message: 'Invalid environment' }] }
    const api = installApi({ environments: diskApi(disk) })
    const user = userEvent.setup()
    await useApp.getState().openWorkspace('/tmp/demo')
    render(<App />)
    const dialog = await openEditor(user)
    expect(within(dialog).getByText(/environments\/broken\.json/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Invalid environment/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Dev' }))
    expect(rowInput('Variable name')).toHaveValue('host')
    expect(api.environments.list).toHaveBeenCalled()
  })

  it('shows the explanatory note under the table', async () => {
    const { user } = await mount()
    await openEditor(user)
    expect(
      screen.getByText(
        'Shared values are saved in the workspace and committed to git. Current values and secrets stay on this machine.',
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
