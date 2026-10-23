// The only way the app runs git: the system `git` binary through execFile, never a shell, so the user's SSH agent,
// credential helper and config apply. Arguments that could force-push, discard work or touch the global config are
// refused before anything is spawned. Errors are GitErrors with user-facing messages; URLs in them never carry
// credentials.

import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync } from 'node:fs'

export type GitErrorCode =
  | 'not_installed'
  | 'auth'
  | 'not_a_repo'
  | 'timeout'
  | 'cancelled'
  | 'rejected'
  | 'conflict'
  | 'identity_missing'
  | 'failed'

export class GitError extends Error {
  constructor(
    public code: GitErrorCode,
    message: string,
    public stderr: string
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface GitOpts {
  /** Defaults to 120 s for network commands (fetch, pull, push, clone, ls-remote) and 30 s for the others. */
  timeoutMs?: number
  /** Aborting kills the process; the call rejects with `cancelled`. */
  signal?: AbortSignal
  /** Written to stdin. Without it stdin is closed at once, so git never waits for input. */
  input?: string
  /** Added to the user's environment. The fixed variables below always win. */
  env?: Record<string, string>
}

/**
 * Arguments `runGit` refuses. Words (no leading dash) are refused as the subcommand; options are refused anywhere
 * before a `--` separator. Pass free text such as commit messages through `input` (`commit -F -`), never as an
 * argument, so it cannot be mistaken for an option.
 */
export const FORBIDDEN_ARGS: readonly string[] = [
  '--force',
  '-f',
  '--force-with-lease',
  '--force-if-includes',
  '--mirror',
  '--hard',
  '--amend',
  '--global',
  '--system',
  'clean',
  'rebase',
  'filter-branch',
  'filter-repo',
  'replace'
]

const NETWORK_COMMANDS = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote'])
const NETWORK_TIMEOUT_MS = 120_000
const LOCAL_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

const FIXED_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }

export const NOT_INSTALLED_MESSAGE =
  'Git is not installed. Install the Xcode Command Line Tools: xcode-select --install'
export const REJECTED_MESSAGE = 'The remote has new changes. Pull first'

/** Global options that take the next argument as their value (`git -C dir status`). */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

/** The subcommand: the first argument that is neither a global option nor its value. */
function subcommandIndex(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    if (GLOBAL_OPTIONS_WITH_VALUE.has(args[i])) i++
    else if (!args[i].startsWith('-')) return i
  }
  return -1
}

/** Why `args` are refused, or null when they may run. */
function forbiddenReason(args: string[]): string | null {
  const sub = subcommandIndex(args)
  const subcommand = sub >= 0 ? args[sub] : null
  if (subcommand !== null && FORBIDDEN_ARGS.includes(subcommand)) return subcommand
  const end = args.indexOf('--')
  const options = end === -1 ? args : args.slice(0, end)
  for (const [i, arg] of options.entries()) {
    if (arg.startsWith('-') && FORBIDDEN_ARGS.includes(arg)) return arg
    if (arg.startsWith('--force-with-lease=') || arg.startsWith('--force-if-includes=')) return arg
    if (subcommand === 'push' && i > sub) {
      // A short-option cluster with -f (`-uf`) or a `+refspec` forces the push.
      if (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) return arg
      if (arg.startsWith('+')) return arg
    }
  }
  return null
}

const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*):\/\/([^/\s@'"]+)@/gi

/**
 * Removes credentials from every URL in `text`. For http(s) the whole user part goes (a token is often the user
 * name); for other schemes only the password does (`ssh://git@host` keeps `git`).
 */
export function stripCredentials(text: string): string {
  return text.replace(URL_WITH_USERINFO, (_match, scheme: string, userinfo: string) => {
    if (/^https?$/i.test(scheme)) return `${scheme}://`
    const user = userinfo.split(':')[0]
    return `${scheme}://${user}@`
  })
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
}

/** The remote an auth failure is about: a URL in git's output, else a remote named in the arguments. */
function remoteName(stderr: string, args: string[], sub: number): string {
  const url = /(?:[a-z][a-z0-9+.-]*:\/\/[^\s'"]+)|(?:[\w.-]+@[\w.-]+:[^\s'"]+)/i.exec(stderr)
  if (url) return url[0]
  const named = args.slice(sub + 1).find((arg) => !arg.startsWith('-'))
  return named ?? 'the remote'
}

const AUTH_PATTERNS = [
  /Authentication failed/i,
  /could not read (Username|Password)/i,
  /terminal prompts disabled/i,
  /Permission denied \(publickey/i,
  /Host key verification failed/i,
  /HTTP Basic: Access denied/i,
  /returned error: 40[13]/i
]
const IDENTITY_PATTERNS = [
  /Please tell me who you are/i,
  /(Author|Committer) identity unknown/i,
  /empty ident name/i,
  /no email was given/i,
  /unable to auto-detect email/i
]

function classify(
  stdout: string,
  stderr: string,
  args: string[]
): { code: GitErrorCode; message: string } {
  const sub = subcommandIndex(args)
  const subcommand = sub >= 0 ? args[sub] : 'git'
  const output = `${stdout}\n${stderr}`
  const line = firstLine(stderr) || firstLine(stdout)
  if (/xcrun: error|active developer path|no developer tools were found/i.test(output)) {
    return { code: 'not_installed', message: NOT_INSTALLED_MESSAGE }
  }
  if (/not a git repository/i.test(stderr)) {
    return { code: 'not_a_repo', message: 'This folder is not a git repository' }
  }
  if (IDENTITY_PATTERNS.some((p) => p.test(stderr))) {
    return { code: 'identity_missing', message: 'Git needs your name and email before it can commit' }
  }
  if (AUTH_PATTERNS.some((p) => p.test(stderr))) {
    return { code: 'auth', message: `Git could not sign in to ${remoteName(stderr, args, sub)}: ${line}` }
  }
  if (/\[rejected\]|\(fetch first\)|non-fast-forward|Updates were rejected/i.test(stderr)) {
    return { code: 'rejected', message: REJECTED_MESSAGE }
  }
  if (/^CONFLICT \(|Automatic merge failed/m.test(output)) {
    return { code: 'conflict', message: 'The merge has conflicts' }
  }
  return { code: 'failed', message: line ? `git ${subcommand} failed: ${line}` : `git ${subcommand} failed` }
}

/** Runs `git <args>` in `cwd` without a shell. Resolves with the output of a zero exit; rejects with a GitError. */
export function runGit(cwd: string, args: string[], opts: GitOpts = {}): Promise<{ stdout: string; stderr: string }> {
  const refused = forbiddenReason(args)
  if (refused !== null) {
    return Promise.reject(new GitError('failed', `Refused to run git with "${refused}"`, ''))
  }
  if (opts.signal?.aborted) {
    return Promise.reject(new GitError('cancelled', 'The git operation was cancelled', ''))
  }
  const sub = subcommandIndex(args)
  const timeoutMs = opts.timeoutMs ?? (NETWORK_COMMANDS.has(args[sub]) ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS)

  return new Promise((resolve, reject) => {
    const killer = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killer.abort()
    }, timeoutMs)
    const onCancel = () => killer.abort()
    opts.signal?.addEventListener('abort', onCancel, { once: true })

    const child = execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, ...opts.env, ...FIXED_ENV },
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: killer.signal,
        windowsHide: true
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onCancel)
        const cleanErr = stripCredentials(stderr)
        if (!error) {
          resolve({ stdout, stderr: cleanErr })
          return
        }
        if (timedOut) {
          reject(new GitError('timeout', `git ${args[sub] ?? ''} took too long and was stopped`.trim(), cleanErr))
        } else if (killer.signal.aborted) {
          reject(new GitError('cancelled', 'The git operation was cancelled', cleanErr))
        } else if (error.code === 'ENOENT') {
          if (!existsSync(cwd)) reject(new GitError('failed', `The folder ${cwd} does not exist`, cleanErr))
          else reject(new GitError('not_installed', NOT_INSTALLED_MESSAGE, cleanErr))
        } else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new GitError('failed', `git ${args[sub]} produced too much output`, cleanErr))
        } else {
          const { code, message } = classify(stripCredentials(stdout), cleanErr, args.map(stripCredentials))
          reject(new GitError(code, message, cleanErr))
        }
      }
    )
    child.stdin?.on('error', () => {
      // git may exit before reading its input; the exit status reports the failure.
    })
    child.stdin?.end(opts.input)
  })
}
