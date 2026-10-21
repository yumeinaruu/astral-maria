import type { ParsedCookie, RequestItem } from '../../shared/types'

// The JSON contract between the main process and the pm runtime (runtime/pm.js) running inside the VM.

/** A response as the runtime sees it: the one being tested, or one returned to `pm.sendRequest`. */
export interface ScriptResponse {
  code: number
  status: string
  headers: [string, string][]
  /** The body decoded as text. */
  body: string
  responseTime: number
  responseSize: number
  cookies: ParsedCookie[]
}

export interface ScriptVariables {
  local: Record<string, string>
  /** null when no environment is selected. */
  environment: Record<string, string> | null
  /** The collection's variables with the session's overrides on top. */
  collection: Record<string, string>
  globals: Record<string, string>
}

export interface ScriptInput {
  phase: 'pre-request' | 'post-response'
  info: {
    eventName: 'prerequest' | 'test'
    requestName: string
    requestId: string
    iteration: number
    iterationCount: number
  }
  /** As edited, variables unresolved. */
  request: RequestItem
  variables: ScriptVariables
  /** The selected environment's name, read by `pm.environment.name`. */
  environmentName?: string
  /** Post-response only. */
  response?: ScriptResponse
}

export interface ScriptTestResult {
  name: string
  passed: boolean
  skipped: boolean
  error?: string
}

export interface ScriptResult {
  /** After pm.request mutations; in a post-response script, the input request unchanged. */
  request: RequestItem
  /** After set/unset/clear. */
  variables: ScriptVariables
  tests: ScriptTestResult[]
  /** postman.setNextRequest; null means stop. Absent when the script did not call it. */
  nextRequest?: string | null
}

/**
 * What `EngineHooks.sendRequest` receives from `pm.sendRequest`: a URL string or a Postman-style request object
 * (`{ url, method, header, body }`), passed through as the script wrote it. The hook resolves to a `ScriptResponse`,
 * which the runtime wraps with `json()`, `text()`, `headers` and the response assertions.
 */
export type SendRequestInput = unknown
