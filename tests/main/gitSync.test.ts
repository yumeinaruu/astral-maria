// Sync end to end through the `git` api group: real git, a local bare remote and two clones (Alice and Bob), with
// git's config isolated by gitSandbox.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createApi } from '../../src/main/api'
import { REJECTED_MESSAGE } from '../../src/main/git/git'
import type { AstralApi } from '../../src/shared/api'
import type { RequestItem, TreeNode } from '../../src/shared/types'
import { bareRemote, commitAll, git, gitSandbox, initRepo, write, type GitSandbox } from './gitHelpers'

const cipher = { encrypt: (s: string) => `x:${s}`, decrypt: (s: string) => s.replace(/^x:/, '') }
const MERGING = 'Finish or abort the merge first'

let box: GitSandbox
let apis = 0
let opened: string[]

beforeEach(() => {
  box = gitSandbox()
  opened = []
})
afterEach(() => {
  box.cleanup()
})

function makeApi(pick: () => Promise<string | null> = async () => null): AstralApi {
  return createApi({
    cipher,
    pickDirectory: pick,
    pickImportFiles: async () => [],
    pickExportPath: async () => null,
    recentFile: path.join(box.root, `recent-${apis++}.json`),
    openPath: async (p) => {
      opened.push(p)
      return ''
    },
  })
}

interface Person {
  api: AstralApi
  dir: string
}

const REQUEST = 'collections/auth-api/login-user.request.json'

/** Alice's workspace with one request, linked to `remote` and synced. */
async function alice(remote: string): Promise<Person> {
  const api = makeApi()
  const dir = path.join(box.root, 'alice')
  await api.workspace.create(dir, 'Team')
  await api.git.link(remote)
  await api.git.setIdentity('Alice', 'alice@example.com')
  const collection = await api.collections.createCollection('Auth API')
  const request = await api.collections.createRequest(collection.path, 'Login user')
  expect(request.path).toBe(REQUEST)
  expect(await api.git.sync('Add login')).toEqual({ kind: 'done', pulled: 0, pushed: 1 })
  return { api, dir }
}

async function cloneAs(name: string, remote: string): Promise<Person> {
  const dir = path.join(box.root, name)
  const api = makeApi(async () => dir)
  const info = await api.git.clone(remote)
  expect(info?.dir).toBe(dir)
  await api.git.setIdentity(name, `${name}@example.com`)
  return { api, dir }
}

async function team(): Promise<{ remote: string; a: Person; b: Person }> {
  const remote = bareRemote(path.join(box.root, 'remote.git'))
  const a = await alice(remote)
  const b = await cloneAs('bob', remote)
  return { remote, a, b }
}

function findNode(nodes: TreeNode[], p: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.path === p) return n
    if (n.kind === 'folder') {
      const found = findNode(n.children, p)
      if (found) return found
    }
  }
  return undefined
}

async function readRequest(p: Person, requestPath = REQUEST): Promise<RequestItem> {
  const { collections } = await p.api.collections.list()
  for (const c of collections) {
    const node = findNode(c.children, requestPath)
    if (node?.kind === 'request') return node.request
  }
  throw new Error(`no request at ${requestPath}`)
}

async function edit(p: Person, patch: Partial<RequestItem>, requestPath = REQUEST): Promise<void> {
  await p.api.collections.saveRequest(requestPath, { ...(await readRequest(p, requestPath)), ...patch })
}

const head = (dir: string, ref = 'HEAD') => git(dir, 'rev-parse', ref).trim()
const subjects = (dir: string, ref = 'HEAD') => git(dir, 'log', '--format=%s', ref).trim().split('\n')
const fileAt = (p: Person, rel = REQUEST) => fs.readFileSync(path.join(p.dir, rel), 'utf8')
const mergeRecord = (dir: string) => path.join(dir, '.git', 'astral-merge.json')

describe('git.link', () => {
  it('links to an empty bare remote, and the first sync pushes and sets the upstream', async () => {
    const remote = bareRemote(path.join(box.root, 'remote.git'))
    const api = makeApi()
    const dir = path.join(box.root, 'ws')
    await api.workspace.create(dir, 'Team')

    const state = await api.git.link(remote)
    expect(state).toMatchObject({
      linked: true,
      branch: 'main',
      remoteUrl: remote,
      ahead: 0,
      behind: 0,
      merging: false,
      conflicts: [],
      identity: null,
    })
    expect(state.changes).toEqual([
      { path: '.gitignore', kind: 'added', label: '.gitignore' },
      { path: 'workspace.json', kind: 'added', label: 'Workspace settings' },
    ])

    await api.git.setIdentity('Alice', 'alice@example.com')
    expect(await api.git.sync('Start')).toEqual({ kind: 'done', pulled: 0, pushed: 1 })
    expect(subjects(remote, 'main')).toEqual(['Start'])
    expect(git(dir, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/main')
    expect(await api.git.state()).toMatchObject({ ahead: 0, behind: 0, changes: [] })
  })

  it('links to a non-empty remote: asks for the identity, then merges unrelated histories', async () => {
    const remote = bareRemote(path.join(box.root, 'remote.git'))
    await alice(remote)
    const api = makeApi()
    const dir = path.join(box.root, 'carol')
    await api.workspace.create(dir, 'Mine')

    await expect(api.git.link(remote)).rejects.toMatchObject({ code: 'identity_missing' })
    await api.git.setIdentity('Carol', 'carol@example.com')
    const state = await api.git.link(remote)
    // Both sides created workspace.json: there is no base to merge against. Identical .gitignore files merge.
    expect(state.merging).toBe(true)
    expect(state.conflicts).toEqual([{ id: 'workspace.json', label: 'Workspace settings', kind: 'file' }])

    const resolved = await api.git.resolve('workspace.json', 'theirs')
    expect(resolved.conflicts).toEqual([])
    // A link never pushes.
    expect(await api.git.finishMerge()).toEqual({ kind: 'done', pulled: 1, pushed: 0 })
    expect(subjects(remote, 'main')).toEqual(['Add login'])
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8')).name).toBe('Team')
    const { collections } = await api.collections.list()
    expect(collections.map((c) => c.name)).toEqual(['Auth API'])
    expect(await api.git.state()).toMatchObject({ merging: false, ahead: 2, behind: 0 })
  })

  it('creates a repository in a workspace that sits inside another repository', async () => {
    const parent = initRepo(path.join(box.root, 'parent'))
    write(parent, 'README.md', 'hi\n')
    commitAll(parent, 'parent')
    const remote = bareRemote(path.join(box.root, 'remote.git'))
    const api = makeApi()
    const dir = path.join(parent, 'ws')
    await api.workspace.create(dir, 'Nested')

    expect(await api.git.state()).toMatchObject({ linked: false, branch: null, changes: [], identity: null })
    await expect(api.git.commit('x')).rejects.toThrow('not a git repository')

    expect(await api.git.link(remote)).toMatchObject({ linked: true, remoteUrl: remote })
    expect(git(dir, 'rev-parse', '--show-toplevel').trim()).toBe(dir)
    expect(git(parent, 'remote').trim()).toBe('')
  })

  it('rejects a URL that looks like an option', async () => {
    const api = makeApi()
    await api.workspace.create(path.join(box.root, 'ws'), 'ws')
    await expect(api.git.link('--upload-pack=touch /tmp/x')).rejects.toThrow('Enter a repository URL')
    await expect(api.git.link('  ')).rejects.toThrow('Enter a repository URL')
  })
})

describe('git.clone', () => {
  it('clones into the picked folder and opens the workspace', async () => {
    const { b } = await team()
    expect(await b.api.git.state()).toMatchObject({ linked: true, branch: 'main', ahead: 0, behind: 0, changes: [] })
    expect((await readRequest(b)).name).toBe('Login user')
  })

  it('creates workspace.json for a repository without one', async () => {
    const remote = bareRemote(path.join(box.root, 'remote.git'))
    const seed = initRepo(path.join(box.root, 'seed'))
    write(seed, 'README.md', 'hello\n')
    commitAll(seed, 'seed')
    git(seed, 'push', '-q', remote, 'main')

    const dir = path.join(box.root, 'Shared APIs')
    const api = makeApi(async () => dir)
    const info = await api.git.clone(remote)
    expect(info).toMatchObject({ name: 'Shared APIs', dir })
    expect(fs.existsSync(path.join(dir, 'workspace.json'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('.local/\n')
    expect((await api.git.state()).changes.map((c) => c.path)).toEqual(['.gitignore', 'workspace.json'])
  })

  it('returns null when the picker is cancelled, and refuses a folder that is not empty', async () => {
    const remote = bareRemote(path.join(box.root, 'remote.git'))
    expect(await makeApi(async () => null).git.clone(remote)).toBeNull()
    const full = path.join(box.root, 'full')
    write(full, 'x.txt', 'x')
    await expect(makeApi(async () => full).git.clone(remote)).rejects.toThrow('Choose an empty folder')
  })
})

describe('git.commit', () => {
  it('repairs .gitignore and never commits .local/', async () => {
    const { a } = await team()
    write(a.dir, '.local/environments/dev.json', '{"values":{"token":"secret"}}')
    fs.rmSync(path.join(a.dir, '.gitignore'))
    await edit(a, { url: 'https://example.com/login' })

    await a.api.git.commit('Change URL')
    expect(fs.readFileSync(path.join(a.dir, '.gitignore'), 'utf8')).toBe('.local/\n')
    expect(git(a.dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual([REQUEST])
    expect(git(a.dir, 'ls-files').split('\n')).not.toContain('.local/environments/dev.json')
  })

  it('refuses when a .local/ path is staged', async () => {
    const { a } = await team()
    write(a.dir, '.local/secret.json', '{}')
    git(a.dir, 'add', '-f', '.local/secret.json')
    const before = head(a.dir)
    await expect(a.api.git.commit('Oops')).rejects.toThrow('.local/')
    expect(head(a.dir)).toBe(before)
  })

  it('is a no-op when nothing changed', async () => {
    const { a } = await team()
    const before = head(a.dir)
    await a.api.git.commit('Nothing')
    expect(head(a.dir)).toBe(before)
  })

  it('asks for the identity, and setIdentity writes it to the repository only', async () => {
    const remote = bareRemote(path.join(box.root, 'remote.git'))
    const api = makeApi()
    const dir = path.join(box.root, 'ws')
    await api.workspace.create(dir, 'ws')
    await api.git.link(remote)
    const globalBefore = fs.readFileSync(process.env.GIT_CONFIG_GLOBAL as string, 'utf8')

    await expect(api.git.commit('First')).rejects.toMatchObject({
      code: 'identity_missing',
      message: 'Git needs your name and email before it can commit',
    })
    await expect(api.git.setIdentity('', 'x@example.com')).rejects.toThrow('Enter your name and email')
    await api.git.setIdentity('Dana Doe', 'dana@example.com')
    expect((await api.git.state()).identity).toEqual({ name: 'Dana Doe', email: 'dana@example.com' })
    expect(git(dir, 'config', '--local', 'user.email').trim()).toBe('dana@example.com')
    expect(fs.readFileSync(process.env.GIT_CONFIG_GLOBAL as string, 'utf8')).toBe(globalBefore)
    await api.git.commit('First')
    expect(subjects(dir)).toEqual(['First'])
  })
})

describe('git.sync', () => {
  it('reports up to date without an empty commit (Review Focus 1)', async () => {
    const { a } = await team()
    const before = head(a.dir)
    expect(await a.api.git.sync(null)).toEqual({ kind: 'up_to_date' })
    expect(await a.api.git.sync('Nothing to say')).toEqual({ kind: 'up_to_date' })
    expect(head(a.dir)).toBe(before)
  })

  it('pushes local commits, and fast-forwards remote-only commits', async () => {
    const { remote, a, b } = await team()
    await edit(a, { url: 'https://example.com/v2' })
    expect(await a.api.git.sync('Use v2')).toEqual({ kind: 'done', pulled: 0, pushed: 1 })
    expect(subjects(remote, 'main')).toEqual(['Use v2', 'Add login'])

    expect(await b.api.git.sync(null)).toEqual({ kind: 'done', pulled: 1, pushed: 0 })
    expect(head(b.dir)).toBe(head(remote, 'main'))
    expect((await readRequest(b)).url).toBe('https://example.com/v2')
  })

  it('merges different requests added to the same collection (Review Focus 2)', async () => {
    const { remote, a, b } = await team()
    await a.api.collections.createRequest('collections/auth-api', 'Logout')
    await b.api.collections.createRequest('collections/auth-api', 'Refresh token')
    expect(await a.api.git.sync('Add logout')).toEqual({ kind: 'done', pulled: 0, pushed: 1 })

    // Bob's commit and the merge commit.
    expect(await b.api.git.sync('Add refresh')).toEqual({ kind: 'done', pulled: 1, pushed: 2 })
    expect(await a.api.git.sync(null)).toEqual({ kind: 'done', pulled: 2, pushed: 0 })
    const names = async (p: Person) => (await p.api.collections.list()).collections[0].children.map((n) => n.name)
    expect(await names(b)).toEqual(['Login user', 'Logout', 'Refresh token'])
    expect(await names(a)).toEqual(await names(b))
    expect((await b.api.collections.list()).errors).toEqual([])
    expect(head(a.dir)).toBe(head(remote, 'main'))
  })

  it('merges different fields of the same request', async () => {
    const { a, b } = await team()
    // Adjacent lines, so git's own merge stops and the field-level merge settles it.
    await edit(a, { method: 'POST' })
    await edit(b, { url: 'https://example.com/login' })
    await a.api.git.sync('Use POST')
    expect(await b.api.git.sync('Set URL')).toEqual({ kind: 'done', pulled: 1, pushed: 2 })
    expect(await readRequest(b)).toMatchObject({ method: 'POST', url: 'https://example.com/login' })
    expect(fs.existsSync(mergeRecord(b.dir))).toBe(false)
  })
})

describe('field conflicts', () => {
  /** Alice and Bob both change the URL and the method of the same request; Bob syncs second. */
  async function conflicted() {
    const t = await team()
    await edit(t.a, { url: 'https://alice.example/login', method: 'PUT' })
    await t.a.api.git.sync('Alice')
    await edit(t.b, { url: 'https://bob.example/login', method: 'POST' })
    const outcome = await t.b.api.git.sync('Bob')
    return { ...t, outcome }
  }

  it('reports each field, refuses other operations, and keeps a per-field choice', async () => {
    const { remote, a, b, outcome } = await conflicted()
    expect(outcome.kind).toBe('conflicts')
    const state = outcome.kind === 'conflicts' ? outcome.state : null
    expect(state).toMatchObject({ merging: true, behind: 1 })
    expect(state?.conflicts).toEqual([
      {
        id: REQUEST,
        label: 'Request "Login user" in Auth API',
        kind: 'fields',
        fields: [
          { path: '["method"]', label: 'Method', ours: 'POST', theirs: 'PUT' },
          { path: '["url"]', label: 'URL', ours: 'https://bob.example/login', theirs: 'https://alice.example/login' },
        ],
      },
    ])
    expect(await b.api.git.state()).toEqual(state)

    await expect(b.api.git.sync(null)).rejects.toThrow(MERGING)
    await expect(b.api.git.pull()).rejects.toThrow(MERGING)
    await expect(b.api.git.push()).rejects.toThrow(MERGING)
    await expect(b.api.git.commit('x')).rejects.toThrow(MERGING)
    await expect(b.api.git.link(remote)).rejects.toThrow(MERGING)
    await expect(b.api.git.finishMerge()).rejects.toThrow('Resolve every conflict first')
    await expect(b.api.git.resolve(REQUEST, { fields: { '["url"]': 'ours' } })).rejects.toThrow(
      'Choose a side for every field',
    )
    await expect(b.api.git.resolve('workspace.json', 'ours')).rejects.toThrow('No conflict for workspace.json')

    const after = await b.api.git.resolve(REQUEST, { fields: { '["url"]': 'ours', '["method"]': 'theirs' } })
    expect(after).toMatchObject({ merging: true, conflicts: [] })
    expect(await readRequest(b)).toMatchObject({ url: 'https://bob.example/login', method: 'PUT' })

    expect(await b.api.git.finishMerge()).toEqual({ kind: 'done', pulled: 1, pushed: 2 })
    expect(head(b.dir)).toBe(head(remote, 'main'))
    expect(fs.existsSync(mergeRecord(b.dir))).toBe(false)
    expect(await a.api.git.sync(null)).toEqual({ kind: 'done', pulled: 2, pushed: 0 })
    expect(await readRequest(a)).toMatchObject({ url: 'https://bob.example/login', method: 'PUT' })
  })

  it.each([
    ['ours', 'https://bob.example/login', 'POST'],
    ['theirs', 'https://alice.example/login', 'PUT'],
  ] as const)('resolves the whole item with %s', async (choice, url, method) => {
    const { b } = await conflicted()
    await b.api.git.resolve(REQUEST, choice)
    expect(await readRequest(b)).toMatchObject({ url, method })
    expect(await b.api.git.finishMerge()).toEqual({ kind: 'done', pulled: 1, pushed: 2 })
  })

  it('keeps the conflicts across a restart', async () => {
    const { b, outcome } = await conflicted()
    const before = outcome.kind === 'conflicts' ? outcome.state : null
    const restarted = makeApi()
    await restarted.workspace.open(b.dir)
    expect(await restarted.git.state()).toEqual(before)
    await restarted.git.resolve(REQUEST, { fields: { '["url"]': 'theirs', '["method"]': 'ours' } })
    expect(await readRequest({ api: restarted, dir: b.dir })).toMatchObject({
      url: 'https://alice.example/login',
      method: 'POST',
    })
    // The merge came from a sync, so finishing it pushes.
    expect(await restarted.git.finishMerge()).toEqual({ kind: 'done', pulled: 1, pushed: 2 })
  })

  it('aborts to the exact pre-merge state, keeps the sync commit, pushes nothing (Review Focus 4)', async () => {
    const { remote, b } = await conflicted()
    const remoteHead = head(remote, 'main')
    const bobCommit = head(b.dir)
    const bobFile = git(b.dir, 'show', `HEAD:${REQUEST}`)

    const state = await b.api.git.abortMerge()
    expect(state).toMatchObject({ merging: false, conflicts: [], changes: [], ahead: 1, behind: 1 })
    expect(head(b.dir)).toBe(bobCommit)
    expect(subjects(b.dir)[0]).toBe('Bob')
    expect(fileAt(b)).toBe(bobFile)
    expect(git(b.dir, 'status', '--porcelain').trim()).toBe('')
    expect(head(remote, 'main')).toBe(remoteHead)
    expect(fs.existsSync(mergeRecord(b.dir))).toBe(false)
  })
})

describe('deleted on one side, changed on the other (Review Focus 3)', () => {
  it.each([
    ['ours', true],
    ['theirs', false],
  ] as const)('deleted on the remote: %s', async (choice, kept) => {
    const { a, b } = await team()
    await a.api.collections.remove(REQUEST)
    await a.api.git.sync('Remove login')
    await edit(b, { url: 'https://bob.example/login' })
    const outcome = await b.api.git.sync('Edit login')
    expect(outcome.kind === 'conflicts' && outcome.state.conflicts).toEqual([
      { id: REQUEST, label: 'Request "Login user" in Auth API', kind: 'deleted_remote' },
    ])
    await b.api.git.resolve(REQUEST, choice)
    expect(fs.existsSync(path.join(b.dir, REQUEST))).toBe(kept)
    if (kept) expect((await readRequest(b)).url).toBe('https://bob.example/login')
    expect(await b.api.git.finishMerge()).toEqual({ kind: 'done', pulled: 1, pushed: 2 })
    expect(git(b.dir, 'ls-files', REQUEST).trim()).toBe(kept ? REQUEST : '')
  })

  it.each([
    ['theirs', true],
    ['ours', false],
  ] as const)('deleted here: %s', async (choice, kept) => {
    const { a, b } = await team()
    await edit(a, { url: 'https://alice.example/login' })
    await a.api.git.sync('Edit login')
    await b.api.collections.remove(REQUEST)
    const outcome = await b.api.git.sync('Remove login')
    expect(outcome.kind === 'conflicts' && outcome.state.conflicts).toEqual([
      { id: REQUEST, label: 'Request "Login user" in Auth API', kind: 'deleted_local' },
    ])
    await b.api.git.resolve(REQUEST, choice)
    expect(fs.existsSync(path.join(b.dir, REQUEST))).toBe(kept)
    if (kept) expect((await readRequest(b)).url).toBe('https://alice.example/login')
    expect(await b.api.git.finishMerge()).toEqual({ kind: 'done', pulled: 1, pushed: 2 })
  })
})

describe('a file that cannot be merged field by field (Review Focus 5)', () => {
  it('becomes a file conflict resolved by a whole-file choice, and opens in the editor', async () => {
    const { a, b } = await team()
    write(a.dir, REQUEST, '{ "name": "Login user", broken\n')
    await a.api.git.sync('Break it')
    await edit(b, { url: 'https://bob.example/login' })
    const mine = fileAt(b)

    const outcome = await b.api.git.sync('Edit login')
    expect(outcome.kind === 'conflicts' && outcome.state.conflicts).toEqual([
      { id: REQUEST, label: 'Request "Login user" in Auth API', kind: 'file' },
    ])
    await b.api.git.openInEditor(REQUEST)
    expect(opened).toEqual([path.join(b.dir, REQUEST)])
    await expect(b.api.git.openInEditor('../outside.json')).rejects.toThrow('No conflict for ../outside.json')
    await expect(b.api.git.resolve(REQUEST, { fields: {} })).rejects.toThrow('Choose a whole file')

    await b.api.git.resolve(REQUEST, 'ours')
    expect(fileAt(b)).toBe(mine)
    expect(await b.api.git.finishMerge()).toEqual({ kind: 'done', pulled: 1, pushed: 2 })
  })
})

describe('git.pull', () => {
  it('refuses when uncommitted changes touch incoming files', async () => {
    const { a, b } = await team()
    await edit(a, { url: 'https://alice.example/login' })
    await a.api.git.sync('Alice')
    await edit(b, { url: 'https://bob.example/login' })
    const mine = fileAt(b)

    await expect(b.api.git.pull()).rejects.toThrow(
      'Your changes to Request "Login user" in Auth API would be overwritten. Commit them first',
    )
    expect(fileAt(b)).toBe(mine)
    expect((await b.api.git.state()).merging).toBe(false)
  })

  it('merges with unrelated uncommitted changes and keeps them', async () => {
    const { a, b } = await team()
    await edit(a, { url: 'https://alice.example/login' })
    await a.api.git.sync('Alice')
    await b.api.environments.save({ id: 'dev', name: 'Dev', variables: [] })

    expect(await b.api.git.pull()).toEqual({ kind: 'done', pulled: 1, pushed: 0 })
    expect((await readRequest(b)).url).toBe('https://alice.example/login')
    expect((await b.api.git.state()).changes.map((c) => c.label)).toEqual(['Environment "Dev"'])
    expect(await b.api.git.pull()).toEqual({ kind: 'up_to_date' })
  })
})

describe('git.push', () => {
  it('pushes local commits, and is up to date with none', async () => {
    const { remote, b } = await team()
    expect(await b.api.git.push()).toEqual({ kind: 'up_to_date' })
    await edit(b, { url: 'https://bob.example/login' })
    await b.api.git.commit('Bob')
    expect(await b.api.git.push()).toEqual({ kind: 'done', pulled: 0, pushed: 1 })
    expect(subjects(remote, 'main')[0]).toBe('Bob')
  })

  it('is rejected when the remote has new changes', async () => {
    const { a, b } = await team()
    await edit(a, { url: 'https://alice.example/login' })
    await a.api.git.sync('Alice')
    await edit(b, { method: 'DELETE' })
    await b.api.git.commit('Bob')
    await expect(b.api.git.push()).rejects.toMatchObject({ code: 'rejected', message: REJECTED_MESSAGE })
  })
})

describe('git.state', () => {
  it('reports a workspace that is not a repository as not linked', async () => {
    const api = makeApi()
    await api.workspace.create(path.join(box.root, 'plain'), 'plain')
    expect(await api.git.state()).toEqual({
      linked: false,
      branch: null,
      remoteUrl: null,
      ahead: 0,
      behind: 0,
      changes: [],
      merging: false,
      conflicts: [],
      identity: null,
    })
    await expect(api.git.sync(null)).rejects.toThrow('not linked')
  })

  it('labels the changes', async () => {
    const { a } = await team()
    await edit(a, { url: 'https://example.com' })
    await a.api.environments.save({ id: 'dev', name: 'Dev', variables: [] })
    expect((await a.api.git.state()).changes).toEqual([
      { path: REQUEST, kind: 'modified', label: 'Request "Login user" in Auth API' },
      { path: 'environments/dev.json', kind: 'added', label: 'Environment "Dev"' },
    ])
  })
})

describe('git.unlink', () => {
  it('removes origin only, keeping the repository and its history', async () => {
    const { a } = await team()
    const before = head(a.dir)
    const state = await a.api.git.unlink()
    expect(state).toMatchObject({ linked: false, remoteUrl: null, branch: 'main', merging: false })
    expect(git(a.dir, 'remote').trim()).toBe('')
    expect(head(a.dir)).toBe(before)
    await expect(a.api.git.sync(null)).rejects.toThrow('not linked')
    // Unlinking again is harmless.
    expect((await a.api.git.unlink()).linked).toBe(false)
  })

  it('refuses during a merge', async () => {
    const { a, b } = await team()
    await edit(a, { url: 'https://alice.example/login' })
    await a.api.git.sync('Alice')
    await edit(b, { url: 'https://bob.example/login' })
    expect((await b.api.git.sync('Bob')).kind).toBe('conflicts')
    await expect(b.api.git.unlink()).rejects.toThrow(MERGING)
    expect(git(b.dir, 'remote').trim()).toBe('origin')
  })
})

describe('git.fetch', () => {
  it('updates how far behind the remote is, without merging', async () => {
    const { a, b } = await team()
    await edit(a, { url: 'https://alice.example/login' })
    await a.api.git.sync('Alice')
    const before = head(b.dir)
    expect((await b.api.git.state()).behind).toBe(0)
    expect(await b.api.git.fetch()).toMatchObject({ behind: 1, ahead: 0 })
    expect(head(b.dir)).toBe(before)
  })
})

describe('resolving a file conflict with the edited file', () => {
  async function fileConflict(): Promise<Person> {
    const { a, b } = await team()
    write(a.dir, REQUEST, '{ "name": "Login user", broken\n')
    await a.api.git.sync('Break it')
    await edit(b, { url: 'https://bob.example/login' })
    expect((await b.api.git.sync('Edit login')).kind).toBe('conflicts')
    return b
  }

  it('refuses while the file has conflict markers or is not valid JSON', async () => {
    const b = await fileConflict()
    const message = '"Request "Login user" in Auth API" still has conflict markers or is not valid JSON'
    write(b.dir, REQUEST, '<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n')
    await expect(b.api.git.resolve(REQUEST, 'edited')).rejects.toThrow(message)
    write(b.dir, REQUEST, '{ "name": ')
    await expect(b.api.git.resolve(REQUEST, 'edited')).rejects.toThrow(message)
    expect((await b.api.git.state()).conflicts).toHaveLength(1)
  })

  it('stages the edited file as it is', async () => {
    const b = await fileConflict()
    const edited = JSON.stringify({ ...(JSON.parse(git(b.dir, 'show', `:2:${REQUEST}`)) as object), url: 'x' }, null, 2)
    write(b.dir, REQUEST, edited)
    expect((await b.api.git.resolve(REQUEST, 'edited')).conflicts).toEqual([])
    expect(await b.api.git.finishMerge()).toEqual({ kind: 'done', pulled: 1, pushed: 2 })
    expect(git(b.dir, 'show', `HEAD:${REQUEST}`)).toBe(edited)
  })

  it('accepts any text without markers for a file that is not JSON', async () => {
    const { a, b } = await team()
    write(a.dir, 'README.md', 'Alice\n')
    await a.api.git.sync('Readme A')
    write(b.dir, 'README.md', 'Bob\n')
    expect((await b.api.git.sync('Readme B')).kind).toBe('conflicts')
    write(b.dir, 'README.md', 'Alice and Bob\n')
    expect((await b.api.git.resolve('README.md', 'edited')).conflicts).toEqual([])
  })

  it('is only for whole-file conflicts', async () => {
    const { a, b } = await team()
    await edit(a, { url: 'https://alice.example/login' })
    await a.api.git.sync('Alice')
    await edit(b, { url: 'https://bob.example/login' })
    expect((await b.api.git.sync('Bob')).kind).toBe('conflicts')
    await expect(b.api.git.resolve(REQUEST, 'edited')).rejects.toThrow('only for a file conflict')
  })
})

describe('workspace.reload', () => {
  it('reads the name a pull brought in without reopening the workspace', async () => {
    const { a, b } = await team()
    const meta = JSON.parse(fileAt(a, 'workspace.json')) as { name: string }
    write(a.dir, 'workspace.json', JSON.stringify({ ...meta, name: 'Team (renamed)' }, null, 2))
    await a.api.git.sync('Rename workspace')
    await b.api.git.pull()
    expect(await b.api.workspace.reload()).toMatchObject({ name: 'Team (renamed)', dir: b.dir })
    expect((await b.api.workspace.recent())[0]).toMatchObject({ name: 'Team (renamed)', dir: b.dir })
  })
})
