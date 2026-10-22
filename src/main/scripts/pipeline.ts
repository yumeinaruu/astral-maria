import type {
  HttpResponse,
  RequestItem,
  ScriptFailure,
  ScriptLog,
  ScriptPhase,
  ScriptReport,
  ScriptTest,
  Scripts,
  SendResult,
} from '../../shared/types'
import { orderedScopes, resolveRequest } from '../http/resolve'
import type { sendRequest } from '../http/sendRequest'
import { fromPostmanRequest } from '../postman/importer'
import { dataScope } from '../runner/dataFile'
import type { EngineHooks, RunOptions, RunOutput } from './engine'
import { PRELUDE } from './prelude'
import type { ScriptInput, ScriptResponse, ScriptResult, ScriptVariables } from './types'

// Runs the scripts of one send around the send itself, as Postman does: the pre-request scripts of the collection,
// its folders (outer to inner) and the request; then the send; then their post-response scripts in the same order.
// Each script gets the request and variables the previous one left. The caller (api.ts) gathers the scripts and
// variables and persists what changed through the `persist` callback, so this module touches no store itself.

/** What the pipeline needs of ScriptHost; tests pass one that runs the engine in-process. */
export interface ScriptRunner {
  run(prelude: string, source: string, input: unknown, hooks: EngineHooks, opts: RunOptions): Promise<RunOutput>
}

export type ScriptLimits = Pick<RunOptions, 'cpuMs' | 'wallMs' | 'memoryBytes'>

/** Per script: 10 s of CPU, 60 s of wall time (timers and pm.sendRequest included), 64 MB of VM memory. */
export const SCRIPT_LIMITS: ScriptLimits = { cpuMs: 10_000, wallMs: 60_000, memoryBytes: 64 * 1024 * 1024 }

/** Where a script lives: `source` labels it in the report, e.g. `Folder "Users"`. */
export interface ScriptSource {
  source: string
  scripts?: Scripts
}

export interface PipelineDeps {
  host: ScriptRunner
  send: typeof sendRequest
  limits?: ScriptLimits
}

export interface PipelineRun {
  /** As edited, variables unresolved. */
  request: RequestItem
  /** Collection, folders from outer to inner, then the request. */
  sources: ScriptSource[]
  /** The variables before the first script; `environment` is null when none is selected. */
  variables: ScriptVariables
  environmentName?: string
  /** The runner's iteration, zero-based, and the number of iterations; 0 of 1 outside the runner. */
  info?: { iteration: number; iterationCount: number }
  /** The runner's data row for this iteration; `{}` outside the runner. */
  iterationData?: Record<string, unknown>
  /** Keys of secret variables, whose values are masked in the report. */
  secretKeys: { environment: string[]; globals: string[] }
  /** Applied to the request after the pre-request scripts, before resolving it (e.g. inherited auth). */
  prepare(request: RequestItem): RequestItem
  /** Saves what the scripts changed; resolves the ids of the environments it wrote. */
  persist(initial: ScriptVariables, final: ScriptVariables): Promise<string[]>
  signal: AbortSignal
}

/** Shown in place of a secret value in the report. */
export const MASK = '••••'
/** Shorter secrets are not masked: they would hide ordinary words. */
const MIN_MASKED_LENGTH = 4

const PHASE_LABEL: Record<ScriptPhase, string> = { 'pre-request': 'Pre-request', 'post-response': 'Post-response' }

const scriptOf = (source: ScriptSource, phase: ScriptPhase): string =>
  (phase === 'pre-request' ? source.scripts?.preRequest : source.scripts?.postResponse) ?? ''

const isBlank = (text: string) => text.trim() === ''

/** Whether any script would run; when none would, the caller sends without starting the VM. */
export function hasScripts(sources: ScriptSource[]): boolean {
  return sources.some((s) => !isBlank(scriptOf(s, 'pre-request')) || !isBlank(scriptOf(s, 'post-response')))
}

export function toScriptResponse(response: HttpResponse): ScriptResponse {
  return {
    code: response.status,
    status: response.statusText,
    headers: response.headers,
    body: Buffer.from(response.bodyBase64, 'base64').toString('utf8'),
    responseTime: response.totalMs,
    responseSize: response.sizeBytes,
    cookies: response.cookies,
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Runs the pre-request scripts, sends the request they produced, then runs the post-response scripts.
 *
 * - A pre-request script that fails stops the rest; nothing is sent and the result is `script_error` (or
 *   `cancelled` when the send was cancelled), carrying the report.
 * - A post-response script that fails is reported and the next one still runs.
 * - When the send itself fails, no post-response script runs.
 * - A script that timed out, ran out of memory or was cancelled loses its tests and leaves the request and variables
 *   as it got them; one that threw keeps what it did before throwing.
 * - `pm.sendRequest` resolves its request against the variables as the calling script started with them and sends
 *   it without scripts, under the same abort signal.
 * - Variables are persisted once, after the last script that ran.
 * - The report's `nextRequest` is the last `postman.setNextRequest` call of all the scripts that ran.
 * - The runner's data row resolves after send-local variables and before the environment, in the send and in
 *   `pm.sendRequest`; outside the runner it is empty.
 */
export async function runWithScripts(deps: PipelineDeps, run: PipelineRun): Promise<SendResult> {
  const limits = deps.limits ?? SCRIPT_LIMITS
  const { signal } = run
  const tests: ScriptTest[] = []
  const logs: ScriptLog[] = []
  const failures: ScriptFailure[] = []
  const secrets = new Set<string>()
  const noteSecrets = (vars: ScriptVariables) => {
    for (const key of run.secretKeys.environment) {
      const value = vars.environment?.[key]
      if (value !== undefined) secrets.add(value)
    }
    for (const key of run.secretKeys.globals) {
      const value = vars.globals[key]
      if (value !== undefined) secrets.add(value)
    }
  }

  let request = run.request
  let variables = run.variables
  let nextRequest: string | null | undefined
  noteSecrets(variables)
  const iteration = run.info ?? { iteration: 0, iterationCount: 1 }
  const iterationData = run.iterationData ?? {}
  const data = dataScope(iterationData)
  const scopesOf = (vars: ScriptVariables) => orderedScopes({ ...vars, data })

  const hooksFor = (vars: ScriptVariables): EngineHooks => ({
    async sendRequest(raw) {
      const converted = fromPostmanRequest(raw, 'pm.sendRequest').request
      const item: RequestItem = {
        id: 'pm.sendRequest',
        ...converted,
        auth: converted.auth.type === 'inherit' ? { type: 'none' } : converted.auth,
      }
      const result = await deps.send(resolveRequest(item, scopesOf(vars)), { signal })
      if (!result.ok) throw new Error(result.error.message)
      return toScriptResponse(result.response)
    },
  })

  /** Runs one phase; resolves the failure that stopped a pre-request phase, if any. */
  async function phase(name: ScriptPhase, response?: ScriptResponse): Promise<ScriptFailure | undefined> {
    for (const source of run.sources) {
      const code = scriptOf(source, name)
      if (isBlank(code)) continue
      if (signal.aborted && name === 'post-response') return undefined
      const input: ScriptInput = {
        phase: name,
        info: {
          eventName: name === 'pre-request' ? 'prerequest' : 'test',
          requestName: run.request.name,
          requestId: run.request.id,
          iteration: iteration.iteration,
          iterationCount: iteration.iterationCount,
        },
        request,
        variables,
        iterationData,
        ...(run.environmentName !== undefined && { environmentName: run.environmentName }),
        ...(response && { response }),
      }
      const out = await deps.host.run(PRELUDE, code, input, hooksFor(variables), { ...limits, signal })
      for (const line of out.logs) logs.push({ ...line, phase: name, source: source.source })
      const result = out.result as ScriptResult | undefined
      if (result) {
        if (name === 'pre-request') request = result.request
        variables = result.variables
        noteSecrets(variables)
        if (result.nextRequest !== undefined) nextRequest = result.nextRequest
        for (const t of result.tests) {
          const test: ScriptTest = { name: t.name, passed: t.passed, skipped: t.skipped, source: source.source }
          if (t.error !== undefined) test.error = t.error
          tests.push(test)
        }
      }
      if (out.error) {
        const failure: ScriptFailure = { phase: name, source: source.source, message: out.error.message }
        failures.push(failure)
        if (name === 'pre-request') return failure
      }
    }
    return undefined
  }

  const finish = async (phaseRan: ScriptPhase): Promise<ScriptReport> => {
    let changedEnvironmentIds: string[] = []
    try {
      changedEnvironmentIds = await run.persist(run.variables, variables)
    } catch (e) {
      failures.push({ phase: phaseRan, source: 'Variables', message: `Variables could not be saved: ${message(e)}` })
    }
    const report: ScriptReport = { tests, logs, failures, changedEnvironmentIds }
    if (nextRequest !== undefined) report.nextRequest = nextRequest
    return mask(report, secrets)
  }

  const stopped = await phase('pre-request')
  if (stopped) {
    const scripts = await finish('pre-request')
    if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'Request was cancelled' }, scripts }
    const failure = scripts.failures.find((f) => f.phase === 'pre-request' && f.source === stopped.source)!
    const text = `${PHASE_LABEL['pre-request']} script of ${failure.source}: ${failure.message}`
    return { ok: false, error: { code: 'script_error', message: text }, scripts }
  }

  const result = await deps.send(resolveRequest(run.prepare(request), scopesOf(variables)), { signal })
  if (!result.ok) return { ...result, scripts: await finish('pre-request') }
  await phase('post-response', toScriptResponse(result.response))
  return { ...result, scripts: await finish('post-response') }
}

/** Replaces every secret value of 4 or more characters, longest first, in `text`. */
export function maskSecrets(text: string, secrets: Iterable<string>): string {
  return masker(secrets)(text)
}

function masker(secrets: Iterable<string>): (text: string) => string {
  const values = [...secrets].filter((s) => s.length >= MIN_MASKED_LENGTH).sort((a, b) => b.length - a.length)
  return (text) => values.reduce((out, secret) => out.split(secret).join(MASK), text)
}

/** Replaces every secret value of 4 or more characters, longest first, in the report's texts. */
function mask(report: ScriptReport, secrets: Set<string>): ScriptReport {
  if (![...secrets].some((s) => s.length >= MIN_MASKED_LENGTH)) return report
  const hide = masker(secrets)
  return {
    ...report,
    logs: report.logs.map((l) => ({ ...l, text: hide(l.text) })),
    tests: report.tests.map((t) => (t.error === undefined ? t : { ...t, error: hide(t.error) })),
    failures: report.failures.map((f) => ({ ...f, message: hide(f.message) })),
  }
}
