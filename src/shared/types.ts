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

/** One uncommitted change in a linked workspace. `label` names it, e.g. `Request "Login user" in Auth API`. */
export interface SyncChange {
  path: string
  kind: 'added' | 'modified' | 'deleted' | 'renamed'
  label: string
}

/**
 * A file the merge could not settle on its own. `id` is the file's workspace-relative path.
 * - `fields`: both sides changed the same fields differently; `fields` lists them, values rendered as short text.
 * - `file`: the file cannot be merged field by field (invalid JSON, not a workspace file, or added on both sides).
 * - `deleted_remote`: deleted on the remote, changed here. `ours` keeps it, `theirs` deletes it.
 * - `deleted_local`: deleted here, changed on the remote. `theirs` keeps it, `ours` deletes it.
 */
export interface SyncConflictItem {
  id: string
  label: string
  kind: 'fields' | 'file' | 'deleted_remote' | 'deleted_local'
  /** `path` is the key to use in `git.resolve`'s field map. */
  fields?: { path: string; label: string; ours: string; theirs: string }[]
}

export interface SyncState {
  /** The workspace folder is itself a git repository (not inside another one) with an `origin` remote. */
  linked: boolean
  branch: string | null
  /** origin's URL, credentials stripped. */
  remoteUrl: string | null
  /** Local commits not on the remote, and remote commits not merged here (as of the last fetch). */
  ahead: number
  behind: number
  changes: SyncChange[]
  merging: boolean
  /** Unresolved items; empty once every one is resolved, even while `merging`. */
  conflicts: SyncConflictItem[]
  /** The name and email git commits with; null when either is missing. */
  identity: { name: string; email: string } | null
}

export type SyncOutcome =
  | { kind: 'up_to_date' }
  | { kind: 'done'; pulled: number; pushed: number }
  | { kind: 'conflicts'; state: SyncState }

/**
 * How to resolve one conflict item: a whole side, or a side per field (keys are the `fields[].path` values).
 * `edited` (only for a `file` item) keeps the working-tree file as the user edited it.
 */
export type SyncChoice = 'ours' | 'theirs' | 'edited' | { fields: Record<string, 'ours' | 'theirs'> }

/** What a load test runs, and how (see `main/load/engine.ts`). */
export interface LoadOptions {
  /** A request path, or a folder or collection path (its requests, in tree order). */
  path: string
  environmentId: string | null
  /** Virtual users, 1 to 1000. */
  vus: number
  /** 1 to 3600. */
  durationSec: number
  /** 0 to the duration; VU `k` starts at `rampUpSec * k / vus`. */
  rampUpSec: number
  /** Pause after each request, per VU: 0 to 60 000. */
  thinkTimeMs: number
  /** 1 to 120. */
  timeoutSec: number
}

/** One second of a load test; `t` is whole seconds since the start, latencies are in ms. */
export interface LoadTick {
  t: number
  /** Requests completed in this second. */
  rps: number
  errors: number
  activeVus: number
  p50: number
  p95: number
  p99: number
}

/** Running totals of a load test; `errorRate` is 0..1, latencies in ms. */
export interface LoadTotals {
  completed: number
  errors: number
  aborted: number
  bytes: number
  rps: number
  p50: number
  p95: number
  p99: number
  mean: number
  max: number
  errorRate: number
  /** Count per response status ("200", "404", …). */
  status: Record<string, number>
  /** Count per error: a transport code (`ECONNREFUSED`, `timeout`, `tls`, …), or `4xx` / `5xx`. */
  errorCodes: Record<string, number>
}

export type LoadStopReason = 'completed' | 'stopped' | 'error'

/**
 * Progress of a load test, pushed from main to the renderer; nothing follows `finished`. A `tick` carries the seconds
 * closed since the previous one; `finished` carries every second of the test. Request URLs have secrets masked.
 */
export type LoadEvent =
  | {
      testId: string
      type: 'started'
      startedAt: string
      requests: { name: string; method: HttpMethod; url: string }[]
      workers: number
    }
  | { testId: string; type: 'tick'; ticks: LoadTick[]; totals: LoadTotals }
  | {
      testId: string
      type: 'finished'
      reason: LoadStopReason
      /** Set when `reason` is `error`. */
      message?: string
      durationMs: number
      totals: LoadTotals
      ticks: LoadTick[]
    }
