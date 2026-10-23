// Helpers for tests that run the real git: temp directories, repos, local bare remotes and fake git binaries.
// Every sandbox points GIT_CONFIG_GLOBAL at a temp file and sets GIT_CONFIG_NOSYSTEM, so neither the user's git
// config nor any real repository is ever read or touched. Identities are set per repo.

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { vi } from 'vitest'

export interface GitSandbox {
  /** A fresh temp directory (real path) for the test's repos. */
  root: string
  cleanup(): void
}

/** Creates a temp root and isolates git's config through env stubs; `cleanup` undoes both. */
export function gitSandbox(): GitSandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-git-')))
  const globalConfig = path.join(root, '.gitconfig-isolated')
  fs.writeFileSync(globalConfig, '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n')
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  const inherited = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG', 'EMAIL']
  const identity = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
  for (const name of [...inherited, ...identity]) {
    vi.stubEnv(name, undefined)
  }
  return {
    root,
    cleanup() {
      vi.unstubAllEnvs()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

/** Runs git synchronously for fixtures; throws on a non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Runs git synchronously for fixtures that are expected to fail (a conflicting merge); returns the exit code. */
export function gitAllowFail(cwd: string, ...args: string[]): number {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status ?? -1
}

/** `git init -b main` with a per-repo identity. */
export function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  setIdentity(dir)
  return dir
}

export function setIdentity(dir: string): void {
  git(dir, 'config', '--local', 'user.name', 'Test User')
  git(dir, 'config', '--local', 'user.email', 'test@example.com')
}

/** Writes a file (creating parent directories) relative to the repo. */
export function write(dir: string, file: string, content: string): void {
  const target = path.join(dir, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

/** Stages everything and commits. */
export function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

/** A bare repository usable as a local remote. */
export function bareRemote(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '--bare', '-b', 'main')
  return dir
}

/** Clones `remote` into `dir` and sets the identity there. */
export function cloneRepo(remote: string, dir: string): string {
  git(path.dirname(dir), 'clone', '-q', remote, dir)
  setIdentity(dir)
  return dir
}

/** Creates `<binDir>/git` as a shell script, for tests that need git to hang or to print what it was given. */
export function fakeGit(binDir: string, script: string): string {
  fs.mkdirSync(binDir, { recursive: true })
  const file = path.join(binDir, 'git')
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return binDir
}
