import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { defaultCommitMessage, describeChanges, labelFor } from '../../src/main/git/describe'
import type { SyncChange } from '../../src/shared/types'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-describe-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function put(rel: string, value: unknown): void {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
}

const noHead = async (): Promise<string | null> => null

describe('describeChanges', () => {
  it('labels every kind of workspace file from the working tree', async () => {
    put('collections/auth/collection.json', { id: 'c', name: 'Auth API', order: [] })
    put('collections/auth/login.request.json', { id: 'r', name: 'Login user' })
    put('collections/auth/users/folder.json', { id: 'f', name: 'Users', order: [] })
    put('collections/auth/users/list.request.json', { id: 'r2', name: 'List users' })
    put('environments/dev.json', { id: 'dev', name: 'Development', variables: [] })
    put('environments/globals.json', { id: 'globals', name: 'Globals', variables: [] })
    put('workspace.json', { version: 1, id: 'w', name: 'Team' })
    put('.gitignore', '.local/\n')

    const changes = await describeChanges(
      dir,
      [
        { path: '.gitignore', kind: 'modified' },
        { path: 'collections/auth/collection.json', kind: 'modified' },
        { path: 'collections/auth/login.request.json', kind: 'added' },
        { path: 'collections/auth/users/folder.json', kind: 'added' },
        {
          path: 'collections/auth/users/list.request.json',
          kind: 'renamed',
          from: 'collections/auth/list.request.json',
        },
        { path: 'environments/dev.json', kind: 'modified' },
        { path: 'environments/globals.json', kind: 'modified' },
        { path: 'workspace.json', kind: 'modified' },
      ],
      noHead,
    )
    expect(changes).toEqual([
      { path: '.gitignore', kind: 'modified', label: '.gitignore' },
      { path: 'collections/auth/collection.json', kind: 'modified', label: 'Collection "Auth API"' },
      { path: 'collections/auth/login.request.json', kind: 'added', label: 'Request "Login user" in Auth API' },
      { path: 'collections/auth/users/folder.json', kind: 'added', label: 'Folder "Users"' },
      { path: 'collections/auth/users/list.request.json', kind: 'renamed', label: 'Request "List users" in Auth API' },
      { path: 'environments/dev.json', kind: 'modified', label: 'Environment "Development"' },
      { path: 'environments/globals.json', kind: 'modified', label: 'Globals' },
      { path: 'workspace.json', kind: 'modified', label: 'Workspace settings' },
    ])
  })

  it('reads deleted files, and a deleted collection, from HEAD', async () => {
    const head: Record<string, string> = {
      'collections/gone/collection.json': JSON.stringify({ id: 'c', name: 'Old API' }),
      'collections/gone/ping.request.json': JSON.stringify({ id: 'r', name: 'Ping' }),
      'environments/prod.json': JSON.stringify({ id: 'p', name: 'Production' }),
    }
    const changes = await describeChanges(
      dir,
      [
        { path: 'collections/gone/collection.json', kind: 'deleted' },
        { path: 'collections/gone/ping.request.json', kind: 'deleted' },
        { path: 'environments/prod.json', kind: 'deleted' },
      ],
      async (p) => head[p] ?? null,
    )
    expect(changes.map((c) => c.label)).toEqual([
      'Collection "Old API"',
      'Request "Ping" in Old API',
      'Environment "Production"',
    ])
  })

  it('falls back to HEAD for an unreadable file, then to the path', async () => {
    put('collections/a/collection.json', '{ broken')
    put('collections/a/r.request.json', '<<<<<<< ours')
    const head: Record<string, string> = { 'collections/a/r.request.json': JSON.stringify({ name: 'From head' }) }
    const changes = await describeChanges(
      dir,
      [
        { path: 'collections/a/r.request.json', kind: 'modified' },
        { path: 'collections/a/collection.json', kind: 'modified' },
        { path: 'collections/a/x.request.json', kind: 'modified' },
      ],
      async (p) => head[p] ?? null,
    )
    // The collection's name is unreadable, so its directory name stands in for it.
    expect(changes.map((c) => c.label)).toEqual([
      'Request "From head" in a',
      'collections/a/collection.json',
      'collections/a/x.request.json',
    ])
  })
})

describe('labelFor', () => {
  it('builds a label from any reader', async () => {
    const files: Record<string, string> = {
      'collections/x/collection.json': JSON.stringify({ name: 'X' }),
      'collections/x/f/r.request.json': JSON.stringify({ name: 'R' }),
    }
    expect(await labelFor('collections/x/f/r.request.json', async (p) => files[p] ?? null)).toBe('Request "R" in X')
    expect(await labelFor('README.md', async () => null)).toBe('README.md')
  })
})

describe('defaultCommitMessage', () => {
  const change = (p: string, kind: SyncChange['kind'] = 'modified'): SyncChange => ({ path: p, kind, label: p })

  it('counts what changed', () => {
    expect(
      defaultCommitMessage([
        change('collections/a/one.request.json'),
        change('collections/a/two.request.json', 'added'),
        change('environments/dev.json'),
      ]),
    ).toBe('Update 2 requests and 1 environment')
  })

  it('uses Add, Delete or Rename when every change is of that kind', () => {
    expect(defaultCommitMessage([change('collections/a/one.request.json', 'added')])).toBe('Add 1 request')
    expect(defaultCommitMessage([change('collections/a/f/folder.json', 'deleted')])).toBe('Delete 1 folder')
    expect(defaultCommitMessage([change('collections/a/x.request.json', 'renamed')])).toBe('Rename 1 request')
  })

  it('lists every group in a fixed order', () => {
    expect(
      defaultCommitMessage([
        change('workspace.json'),
        change('environments/globals.json'),
        change('notes.txt'),
        change('collections/a/collection.json'),
        change('collections/a/f/folder.json'),
        change('collections/b/collection.json'),
        change('collections/a/r.request.json'),
      ]),
    ).toBe('Update 1 request, 1 folder, 2 collections, globals, workspace settings and 1 file')
  })

  it('has a message for no changes', () => {
    expect(defaultCommitMessage([])).toBe('Update workspace')
  })
})
