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

/** Script source as written by the user; run by the scripting plan, only stored for now. */
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

export type SendResult =
  | { ok: true; response: HttpResponse }
  | { ok: false; error: { code: string; message: string } }
