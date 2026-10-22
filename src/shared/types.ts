export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

export interface KeyValue {
  key: string
  value: string
  enabled: boolean
  description?: string
}

export type RequestBody =
  | { mode: 'none' }
  | { mode: 'raw'; language: 'json' | 'text' | 'xml' | 'html'; content: string }
  | { mode: 'urlencoded'; fields: KeyValue[] }
  | { mode: 'formdata'; fields: KeyValue[] }

export type Auth =
  | { type: 'none' }
  | { type: 'inherit' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' }

/** Script source as written by the user; run around every send (see `main/scripts/pipeline.ts`). */
export interface Scripts {
  preRequest: string
  postResponse: string
}

/** `url` is the base URL without query string; `params` is the source of truth for the query. */
export interface RequestItem {
  id: string
  name: string
  method: HttpMethod
  url: string
  params: KeyValue[]
  headers: KeyValue[]
  body: RequestBody
  auth: Auth
  scripts?: Scripts
}

/** All `path` values are workspace-relative with `/` separators. */
export interface FolderNode {
  kind: 'folder'
  id: string
  name: string
  path: string
  children: TreeNode[]
  scripts?: Scripts
}

export interface RequestNode {
  kind: 'request'
  id: string
  name: string
  path: string
  request: RequestItem
  /** sha256 (hex) of the request file's bytes; passed back to `saveRequest` to detect changes made on disk. */
  revision: string
}

export type TreeNode = FolderNode | RequestNode

export interface CollectionTree {
  id: string
  name: string
  path: string
  variables: KeyValue[]
  auth: Auth
  children: TreeNode[]
  scripts?: Scripts
}

export interface LoadError {
  path: string
  message: string
}

export interface EnvVar {
  key: string
  value: string
  currentValue?: string
  secret: boolean
  enabled: boolean
  /**
   * Set by `environments.list` on a secret whose stored value cannot be decrypted on this machine. Saving it back
   * with `locked: true` and no `currentValue` keeps the stored (encrypted) value; a new `currentValue` replaces it.
   */
  locked?: boolean
  /**
   * On a locked secret whose key was renamed in the editor: the key its encrypted value is stored under, so saving
   * moves the value to the new key instead of dropping it. Never written to disk.
   */
  lockedKey?: string
  /**
   * A non-secret variable the editor shows and writes as its current value, even where that equals the initial one.
   * Per machine: kept in `.local/`, never in the committed file. Ignored on secrets, which are always local.
   */
  local?: boolean
}

export interface Environment {
  id: string
  name: string
  variables: EnvVar[]
}

export interface WorkspaceInfo {
  id: string
  name: string
  dir: string
}

export interface ParsedCookie {
  name: string
  value: string
  attributes: Record<string, string | true>
}

export interface HttpResponse {
  status: number
  statusText: string
  headers: [string, string][]
  bodyBase64: string
  bodyTruncated: boolean
  sizeBytes: number
  totalMs: number
  finalUrl: string
  redirects: number
  cookies: ParsedCookie[]
}

export type ScriptPhase = 'pre-request' | 'post-response'

/** One console line of a script; `source` names where the script lives, e.g. `Folder "Users"`. */
export interface ScriptLog {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
  phase: ScriptPhase
  source: string
}

export interface ScriptTest {
  name: string
  passed: boolean
  skipped: boolean
  error?: string
  source: string
}

/** A script that threw, timed out, ran out of memory or was cancelled. */
export interface ScriptFailure {
  phase: ScriptPhase
  source: string
  message: string
}

/** What the scripts of one send did. */
export interface ScriptReport {
  tests: ScriptTest[]
  logs: ScriptLog[]
  failures: ScriptFailure[]
  /** Environments (and `globals`) whose current values the scripts changed and that were saved. */
  changedEnvironmentIds: string[]
  /** The last `postman.setNextRequest` of this send's scripts; null means stop. Absent when none called it. */
  nextRequest?: string | null
}

/**
 * `scripts` is present only when at least one script ran. A failed pre-request script gives
 * `{ ok: false, error: { code: 'script_error', message }, scripts }` and nothing is sent.
 */
export type SendResult =
  | { ok: true; response: HttpResponse; scripts?: ScriptReport }
  | { ok: false; error: { code: string; message: string }; scripts?: ScriptReport }

export type ImportKind = 'collection' | 'environment' | 'globals'

/** One file (or pasted text) imported; `source` is its file name or "Pasted text". */
export interface ImportedItem {
  source: string
  kind: ImportKind
  name: string
  warnings: string[]
}

export interface ImportReport {
  imported: ImportedItem[]
  failed: { source: string; message: string }[]
}

/** What the collection runner runs, and how (see `main/runner/runner.ts`). */
export interface RunOptions {
  /** A collection or folder path. */
  path: string
  /** Request paths to run, in tree order; requests not listed are skipped. */
  requestPaths: string[]
  environmentId: string | null
  iterations: number
  delayMs: number
  data: { name: string; rows: Record<string, unknown>[] } | null
  /** When false, variable changes last only within the run and are never persisted. */
  keepVariables: boolean
  stopOnError: boolean
}

/** One request execution of a run. */
export interface RunResult {
  /** 0-based. */
  iteration: number
  path: string
  name: string
  method: HttpMethod
  /** The final URL, secrets masked. */
  url: string
  status?: number
  statusText?: string
  timeMs?: number
  sizeBytes?: number
  tests: ScriptTest[]
  failures: ScriptFailure[]
  /** A send error, a load error or a script_error message. */
  error?: string
}

export type StopReason = 'completed' | 'stopped' | 'error' | 'loop_guard' | `next_request_not_found: "${string}"`

/** Progress of a run, pushed from main to the renderer; nothing follows `finished`. */
export type RunEvent =
  | { runId: string; type: 'started'; total: number; startedAt: string }
  | { runId: string; type: 'result'; result: RunResult }
  | { runId: string; type: 'finished'; reason: StopReason; durationMs: number }
