import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { readStatus } from '../../src/main/git/status'
import {
  bareRemote,
  cloneRepo,
  commitAll,
  git,
  gitAllowFail,
  gitSandbox,
  initRepo,
  write,
  type GitSandbox
} from './gitHelpers'

let box: GitSandbox
beforeEach(() => {
  box = gitSandbox()
})
afterEach(() => {
  box.cleanup()
})

describe('readStatus', () => {
  it('reports a plain directory as not a repo', async () => {
    const plain = path.join(box.root, 'plain')
    fs.mkdirSync(plain)
    expect(await readStatus(plain)).toEqual({
      repo: false,
      branch: null,
      upstream: null,
      remoteUrl: null,
      ahead: 0,
      behind: 0,
      changes: [],
      merging: false,
      conflicted: []
    })
  })

  it('reads a fresh repo with no commits', async () => {
    const repo = initRepo(path.join(box.root, 'repo'))
    write(repo, 'workspace.json', '{}')
    write(repo, 'collections/api/collection.json', '{}')
    expect(await readStatus(repo)).toEqual({
      repo: true,
      branch: 'main',
      upstream: null,
      remoteUrl: null,
      ahead: 0,
      behind: 0,
      changes: [
        { path: 'collections/api/collection.json', kind: 'added' },
        { path: 'workspace.json', kind: 'added' }
      ],
      merging: false,
      conflicted: []
    })
  })

  it('lists changes of every kind, including a rename', async () => {
    const repo = initRepo(path.join(box.root, 'repo'))
    write(repo, 'a.json', '{"a":1}')
    write(repo, 'b.json', '{"b":1}')
    write(repo, 'c.json', '{"c":1}')
    write(repo, 'd.json', '{"d":1}')
    commitAll(repo, 'init')

    write(repo, 'a.json', '{"a":2}') // modified, unstaged
    fs.rmSync(path.join(repo, 'b.json')) // deleted, unstaged
    fs.mkdirSync(path.join(repo, 'renamed'))
    git(repo, 'mv', 'c.json', 'renamed/c.json') // renamed, staged
    git(repo, 'rm', '-q', 'd.json') // deleted, staged
    write(repo, 'staged.json', '{}') // added, staged
    git(repo, 'add', 'staged.json')
    write(repo, 'new/dir/untracked.json', '{}') // added, untracked, inside new directories

    const status = await readStatus(repo)
    expect(status.changes).toEqual([
      { path: 'a.json', kind: 'modified' },
      { path: 'b.json', kind: 'deleted' },
      { path: 'd.json', kind: 'deleted' },
      { path: 'new/dir/untracked.json', kind: 'added' },
      { path: 'renamed/c.json', kind: 'renamed', from: 'c.json' },
      { path: 'staged.json', kind: 'added' }
    ])
  })

  it('handles paths with spaces and non-ASCII characters', async () => {
    const repo = initRepo(path.join(box.root, 'repo'))
    write(repo, 'collections/My API/запрос "1".json', '{}')
    const status = await readStatus(repo)
    expect(status.changes).toEqual([{ path: 'collections/My API/запрос "1".json', kind: 'added' }])
  })

  it('counts ahead and behind against a local bare remote', async () => {
    const remote = bareRemote(path.join(box.root, 'remote.git'))
    const alice = cloneRepo(remote, path.join(box.root, 'alice'))
    write(alice, 'a.json', '{}')
    commitAll(alice, 'first')
    git(alice, 'push', '-q', '-u', 'origin', 'main')

    const bob = cloneRepo(remote, path.join(box.root, 'bob'))
    write(alice, 'b.json', '{}')
    commitAll(alice, 'second')
    write(alice, 'c.json', '{}')
    commitAll(alice, 'third')
    git(alice, 'push', '-q')

    write(bob, 'mine.json', '{}')
    commitAll(bob, 'mine')
    git(bob, 'fetch', '-q')

    const status = await readStatus(bob)
    expect(status).toMatchObject({
      repo: true,
      branch: 'main',
      upstream: 'origin/main',
      remoteUrl: remote,
      ahead: 1,
      behind: 2,
      changes: []
    })
  })

  it('strips credentials from the remote URL', async () => {
    const repo = initRepo(path.join(box.root, 'repo'))
    git(repo, 'remote', 'add', 'origin', 'https://user:token@example.com/team/repo.git')
    expect((await readStatus(repo)).remoteUrl).toBe('https://example.com/team/repo.git')
  })

  it('reports a detached HEAD as a null branch', async () => {
    const repo = initRepo(path.join(box.root, 'repo'))
    write(repo, 'a.json', '{}')
    commitAll(repo, 'one')
    write(repo, 'a.json', '{"x":1}')
    commitAll(repo, 'two')
    git(repo, 'checkout', '-q', '--detach', 'HEAD~1')
    const status = await readStatus(repo)
    expect(status.repo).toBe(true)
    expect(status.branch).toBeNull()
    expect(status.upstream).toBeNull()
  })

  it('reports a merge in progress and its conflicted paths', async () => {
    const repo = initRepo(path.join(box.root, 'repo'))
    write(repo, 'a.json', '{"v":0}')
    write(repo, 'b.json', '{"v":0}')
    write(repo, 'c.json', '{"v":0}')
    commitAll(repo, 'base')
    git(repo, 'checkout', '-q', '-b', 'other')
    write(repo, 'a.json', '{"v":"theirs"}')
    write(repo, 'b.json', '{"v":"theirs"}')
    write(repo, 'c.json', '{"v":"theirs"}')
    commitAll(repo, 'theirs')
    git(repo, 'checkout', '-q', 'main')
    write(repo, 'a.json', '{"v":"ours"}')
    fs.rmSync(path.join(repo, 'b.json'))
    commitAll(repo, 'ours')

    expect(gitAllowFail(repo, 'merge', '--no-ff', '--no-commit', 'other')).not.toBe(0)

    const status = await readStatus(repo)
    expect(status.merging).toBe(true)
    expect(status.conflicted).toEqual(['a.json', 'b.json'])
    // c.json merged cleanly and is staged; conflicted paths are not listed as changes.
    expect(status.changes).toEqual([{ path: 'c.json', kind: 'modified' }])

    git(repo, 'merge', '--abort')
    const after = await readStatus(repo)
    expect(after.merging).toBe(false)
    expect(after.conflicted).toEqual([])
  })

  it('never lists .local/, even when .gitignore was removed', async () => {
    const repo = initRepo(path.join(box.root, 'repo'))
    write(repo, '.gitignore', '.local/\n')
    write(repo, 'workspace.json', '{}')
    commitAll(repo, 'init')

    fs.rmSync(path.join(repo, '.gitignore'))
    write(repo, '.local/secrets.json', '{"token":"x"}')
    write(repo, '.local/nested/state.json', '{}')
    write(repo, 'collections/.local/kept.json', '{}')

    const status = await readStatus(repo)
    expect(status.changes).toEqual([
      { path: '.gitignore', kind: 'deleted' },
      { path: 'collections/.local/kept.json', kind: 'added' }
    ])
  })
})
