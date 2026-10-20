import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Whether the renderer may load `url`: the app's own files under `rendererRoot`, devtools, and (in development) the
 * Vite dev server. Everything else, including any other local file, is cancelled.
 */
export function isAllowedRendererUrl(url: string, opts: { rendererRoot: string; devServerUrl?: string }): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'devtools:') return true
  if (parsed.protocol === 'file:') {
    if (parsed.host !== '') return false
    let file: string
    try {
      file = fileURLToPath(parsed)
    } catch {
      return false
    }
    const rel = path.relative(path.resolve(opts.rendererRoot), file)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  if (opts.devServerUrl) {
    try {
      const dev = new URL(opts.devServerUrl)
      const sameHost = parsed.host === dev.host
      const isSocket = parsed.protocol === 'ws:' || parsed.protocol === 'wss:'
      return sameHost && (parsed.protocol === dev.protocol || isSocket)
    } catch {
      return false
    }
  }
  return false
}

/**
 * Permission requests and checks (camera, notifications, geolocation, clipboard reading, ...) are all denied, except
 * writing to the clipboard, which the "Copy body" button needs.
 */
export function isPermissionAllowed(permission: string): boolean {
  return permission === 'clipboard-sanitized-write'
}

/** The Vite dev server to load the renderer from: only ever in an unpackaged (development) run. */
export function devServerUrlFor(opts: { isPackaged: boolean; rendererUrl: string | undefined }): string | undefined {
  return !opts.isPackaged && opts.rendererUrl ? opts.rendererUrl : undefined
}

export interface E2eContext {
  /** Recorded for the caller; the rules are the same for packaged builds, whose smoke run uses these hooks too. */
  isPackaged: boolean
  nodeEnv: string | undefined
  /** `ASTRAL_E2E_WORKSPACE`. */
  workspace: string | undefined
  /** An explicit `--user-data-dir` switch was given. */
  userDataArgPresent: boolean
  tmpdir: string
}

/**
 * Whether the e2e hooks (mock keychain, workspace folder from the environment instead of the folder dialog) may be
 * used: only for NODE_ENV=test with an absolute workspace path strictly inside the temp directory and an explicit
 * user-data directory. Anything else ignores them, so environment variables cannot change how a normal launch
 * stores secrets or which folder it opens.
 */
export function isE2eAllowed(ctx: E2eContext): boolean {
  if (ctx.nodeEnv !== 'test' || !ctx.userDataArgPresent) return false
  if (!ctx.workspace || !path.isAbsolute(ctx.workspace)) return false
  const rel = path.relative(path.resolve(ctx.tmpdir), path.resolve(ctx.workspace))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
