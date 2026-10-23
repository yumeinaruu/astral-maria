import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { FORBIDDEN_ARGS, GitError, runGit, stripCredentials } from '../../src/main/git/git'
import { fakeGit, gitSandbox, initRepo, type GitSandbox } from './gitHelpers'

let box: GitSandbox
beforeEach(() => {
  box = gitSandbox()
})
afterEach(() => {
  box.cleanup()
})

async function gitError(promise: Promise<unknown>): Promise<GitError> {
  const err = await promise.then(
    () => {
      throw new Error('expected runGit to fail')
    },
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(GitError)
  return err as GitError
}

/** A fake git that records that it ran, so a test can assert that nothing was spawned. */
function markerGit(): { env: Record<string, string>; marker: string } {
  const marker = path.join(box.root, 'spawned')
  const bin = fakeGit(path.join(box.root, 'bin'), `/usr/bin/touch '${marker}'`)
  return { env: { PATH: bin }, marker }
}

describe('runGit', () => {
  it('returns stdout', async () => {
    const repo = initRepo(path.join(box.root, 'repo'))
    const { stdout } = await runGit(repo, ['rev-parse', '--is-inside-work-tree'])
    expect(stdout).toBe('true\n')
  })

  it('writes input to stdin', async () => {
    const { stdout } = await runGit(box.root, ['hash-object', '--stdin'], { input: 'hello\n' })
    expect(stdout.trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('closes stdin when there is no input, so git never waits for it', async () => {
    const { stdout } = await runGit(box.root, ['hash-object', '--stdin'], { timeoutMs: 5_000 })
    expect(stdout.trim()).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  })

  it('runs without a shell and with the fixed environment', async () => {
    const bin = fakeGit(
      path.join(box.root, 'bin'),
      'printf "%s|" "$@"; echo; echo "$GIT_TERMINAL_PROMPT $GIT_OPTIONAL_LOCKS $LC_ALL $EXTRA"'
    )
    const { stdout } = await runGit(box.root, ['log', '$(touch x)', 'a b;c'], {
      env: { PATH: bin, EXTRA: 'extra', LC_ALL: 'en_US.UTF-8', GIT_TERMINAL_PROMPT: '1' }
    })
    expect(stdout).toBe('log|$(touch x)|a b;c|\n0 0 C extra\n')
    expect(fs.existsSync(path.join(box.root, 'x'))).toBe(false)
  })

  it('maps a missing git binary to not_installed', async () => {
    const empty = path.join(box.root, 'empty-bin')
    fs.mkdirSync(empty)
    const err = await gitError(runGit(box.root, ['status'], { env: { PATH: empty } }))
    expect(err.code).toBe('not_installed')
    expect(err.message).toBe('Git is not installed. Install the Xcode Command Line Tools: xcode-select --install')
  })

  it('maps the macOS git shim without developer tools to not_installed', async () => {
    const bin = fakeGit(
      path.join(box.root, 'bin'),
      'echo "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun" >&2; exit 1'
    )
    const err = await gitError(runGit(box.root, ['status'], { env: { PATH: bin } }))
    expect(err.code).toBe('not_installed')
  })

  it('reports a missing directory without claiming git is missing', async () => {
    const err = await gitError(runGit(path.join(box.root, 'nope'), ['status']))
    expect(err.code).toBe('failed')
    expect(err.message).toContain('does not exist')
  })

  it('maps a plain directory to not_a_repo', async () => {
    const plain = path.join(box.root, 'plain')
    fs.mkdirSync(plain)
    const err = await gitError(runGit(plain, ['status']))
    expect(err.code).toBe('not_a_repo')
    expect(err.stderr).toMatch(/not a git repository/)
  })

  it('maps other failures to failed with git’s first stderr line', async () => {
    const repo = initRepo(path.join(box.root, 'repo'))
    const err = await gitError(runGit(repo, ['rev-parse', '--verify', 'no-such-ref']))
    expect(err.code).toBe('failed')
    expect(err.message).toMatch(/Needed a single revision/)
  })

  it('maps a missing identity to identity_missing', async () => {
    const repo = path.join(box.root, 'repo')
    fs.mkdirSync(repo)
    await runGit(repo, ['init', '-q', '-b', 'main'])
    // useConfigOnly keeps git from guessing an identity from the host name.
    await runGit(repo, ['config', '--local', 'user.useConfigOnly', 'true'])
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
    await runGit(repo, ['add', '-A'])
    const err = await gitError(runGit(repo, ['commit', '-q', '-m', 'x']))
    expect(err.code).toBe('identity_missing')
  })

  it('maps authentication failures and names the remote without credentials', async () => {
    const bin = fakeGit(
      path.join(box.root, 'bin'),
      "echo \"fatal: Authentication failed for 'https://user:s3cret@example.com/team/repo.git/'\" >&2; exit 128"
    )
    const err = await gitError(runGit(box.root, ['fetch', 'origin'], { env: { PATH: bin } }))
    expect(err.code).toBe('auth')
    expect(err.message).toBe(
      "Git could not sign in to https://example.com/team/repo.git/: fatal: Authentication failed for 'https://example.com/team/repo.git/'"
    )
    expect(err.stderr).not.toContain('s3cret')
  })

  it('maps an ssh permission failure to auth', async () => {
    const bin = fakeGit(
      path.join(box.root, 'bin'),
      'echo "git@example.com: Permission denied (publickey)." >&2; echo "fatal: Could not read from remote repository." >&2; exit 128'
    )
    const err = await gitError(runGit(box.root, ['push', 'origin', 'HEAD'], { env: { PATH: bin } }))
    expect(err.code).toBe('auth')
    expect(err.message).toBe('Git could not sign in to origin: git@example.com: Permission denied (publickey).')
  })

  it('maps a rejected push to rejected', async () => {
    const bin = fakeGit(
      path.join(box.root, 'bin'),
      [
        'echo "To /tmp/remote.git" >&2',
        'echo " ! [rejected]        main -> main (fetch first)" >&2',
        "echo \"error: failed to push some refs to '/tmp/remote.git'\" >&2",
        'exit 1'
      ].join('\n')
    )
    const err = await gitError(runGit(box.root, ['push', 'origin', 'HEAD'], { env: { PATH: bin } }))
    expect(err.code).toBe('rejected')
    expect(err.message).toBe('The remote has new changes. Pull first')
  })

  it('maps a conflicting merge to conflict', async () => {
    const bin = fakeGit(
      path.join(box.root, 'bin'),
      'echo "CONFLICT (content): Merge conflict in a.json"; echo "Automatic merge failed; fix conflicts and then commit the result."; exit 1'
    )
    const err = await gitError(runGit(box.root, ['merge', 'origin/main'], { env: { PATH: bin } }))
    expect(err.code).toBe('conflict')
  })

  it('stops a command that runs past its timeout', async () => {
    const bin = fakeGit(path.join(box.root, 'bin'), 'exec /bin/sleep 10')
    const started = Date.now()
    const err = await gitError(runGit(box.root, ['status'], { env: { PATH: bin }, timeoutMs: 200 }))
    expect(err.code).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('kills the process when cancelled', async () => {
    const bin = fakeGit(path.join(box.root, 'bin'), 'exec /bin/sleep 10')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    const err = await gitError(runGit(box.root, ['fetch'], { env: { PATH: bin }, signal: controller.signal }))
    expect(err.code).toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('does not spawn when the signal is already aborted', async () => {
    const { env, marker } = markerGit()
    const controller = new AbortController()
    controller.abort()
    const err = await gitError(runGit(box.root, ['status'], { env, signal: controller.signal }))
    expect(err.code).toBe('cancelled')
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('refuses every forbidden argument without spawning', async () => {
    const { env, marker } = markerGit()
    expect(FORBIDDEN_ARGS.length).toBeGreaterThan(0)
    for (const arg of FORBIDDEN_ARGS) {
      const args = arg.startsWith('-') ? ['push', arg, 'origin', 'main'] : [arg]
      const err = await gitError(runGit(box.root, args, { env }))
      expect(err.code, arg).toBe('failed')
      expect(err.message, arg).toMatch(/^Refused to run/)
    }
    expect(fs.existsSync(marker)).toBe(false)
  })

  it.each([
    [['push', '--force-with-lease=main:abc', 'origin']],
    [['push', '-uf', 'origin', 'HEAD']],
    [['push', 'origin', '+HEAD:main']],
    [['reset', '--hard', 'HEAD~1']],
    [['config', '--global', 'user.name', 'x']],
    [['-C', '.', 'clean', '-fdx']],
    [['-c', 'core.x=1', 'clean']]
  ])('refuses %j', async (args) => {
    const { env, marker } = markerGit()
    const err = await gitError(runGit(box.root, args, { env }))
    expect(err.message).toMatch(/^Refused to run/)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('allows forbidden words after the -- separator and as non-subcommand values', async () => {
    const { env, marker } = markerGit()
    await runGit(box.root, ['rm', '--cached', '--', '-f', 'clean'], { env })
    await runGit(box.root, ['show', 'clean'], { env })
    expect(fs.existsSync(marker)).toBe(true)
  })

  it('strips credentials from URLs in messages', async () => {
    const bin = fakeGit(
      path.join(box.root, 'bin'),
      "echo \"fatal: unable to access 'https://user:token@example.com/repo.git/': Could not resolve host\" >&2; exit 128"
    )
    const args = ['ls-remote', 'https://user:token@example.com/repo.git']
    const err = await gitError(runGit(box.root, args, { env: { PATH: bin } }))
    expect(err.code).toBe('failed')
    expect(err.message).toContain("'https://example.com/repo.git/'")
    expect(err.message).not.toContain('token')
    expect(err.stderr).not.toContain('token')
  })
})

describe('stripCredentials', () => {
  it.each([
    ['https://user:token@host/x.git', 'https://host/x.git'],
    ['https://ghp_abc123@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['http://u:p@localhost:8080/r', 'http://localhost:8080/r'],
    ['ssh://git@host/o/r.git', 'ssh://git@host/o/r.git'],
    ['ssh://git:secret@host/o/r.git', 'ssh://git@host/o/r.git'],
    ['git@github.com:o/r.git', 'git@github.com:o/r.git'],
    ["fetch 'https://a:b@h/r' failed", "fetch 'https://h/r' failed"],
    ['/local/path/repo.git', '/local/path/repo.git']
  ])('%s → %s', (input, expected) => {
    expect(stripCredentials(input)).toBe(expected)
  })
})
