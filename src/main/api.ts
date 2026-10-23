import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AstralApi } from '../shared/api'
import type {
  Auth,
  CollectionTree,
  Environment,
  KeyValue,
  LoadEvent,
  RequestItem,
  RequestNode,
  RunEvent,
  Scripts,
  SendResult,
  TreeNode,
  WorkspaceInfo,
} from '../shared/types'
import { OperationTracker } from './flushGuard'
import { orderedScopes, resolveRequest, type VariableScope } from './http/resolve'
import { requestUrl, sendRequest } from './http/sendRequest'
import { snippet } from './http/snippets'
import { startLoad, validateLoadOptions, type LoadHandle, type WorkerLike } from './load/engine'
import type { WorkerInit } from './load/worker'
import { dataScope, MAX_DATA_BYTES, parseDataFile } from './runner/dataFile'
import {
  abortableSleep,
  fileName,
  startRun,
  type PlanEntry,
  type RunHandle,
  type VariableOverlay,
} from './runner/runner'
import {
  hasScripts,
  maskSecrets,
  runWithScripts,
  type ScriptLimits,
  type ScriptRunner,
  type ScriptSource,
} from './scripts/pipeline'
import type { ScriptVariables } from './scripts/types'
import { CollectionStore } from './storage/collectionStore'
import { EnvironmentStore, valuesOf, type SecretCipher } from './storage/environmentStore'
import { readJson, writeJsonAtomic } from './storage/fsJson'
import * as gitSync from './git/sync'
import { cloneWorkspace, createWorkspace, openWorkspace, readWorkspaceInfo } from './storage/workspaceStore'
import { exportCollection, exportEnvironment, importFiles, importText } from './transfer'

export interface ApiDeps {
  cipher: SecretCipher
  /** Folder picker; `clone` asks for the (empty) folder to clone into. */
  pickDirectory: (purpose?: 'workspace' | 'clone') => Promise<string | null>
  /** Open dialog for Postman files; an empty list when cancelled. */
  pickImportFiles: () => Promise<string[]>
  /** Save dialog suggesting `defaultName`; null when cancelled. */
  pickExportPath: (defaultName: string) => Promise<string | null>
  recentFile: string
  /** Store operations are tracked here so a quit can wait for them. */
  operations?: OperationTracker
  /** Called when the renderer acknowledges a flush request (`app.flushed`). */
  onFlushed?: () => void
  /** The script sandbox (one per app). Without it, scripts are not run and every send takes the plain path. */
  scriptHost?: ScriptRunner
  /** Per-script limits; tests lower them. */
  scriptLimits?: ScriptLimits
  /** Open dialog for one runner data file (.csv / .json); null when cancelled. Without it, nothing is picked. */
  pickDataFile?: () => Promise<string | null>
  /** Pushes a runner event to the renderer. */
  emitRunEvent?: (event: RunEvent) => void
  /** Opens a file in the OS default app (Electron's `shell.openPath`); resolves an error message, '' on success. */
  openPath?: (absPath: string) => Promise<string>
  /** Starts one load test worker thread. Without it, `load.start` rejects with `load_unavailable`. */
  spawnLoadWorker?: (init: WorkerInit) => WorkerLike
  /** Pushes a load test event to the renderer. */
  emitLoadEvent?: (event: LoadEvent) => void
  /** Every load test in progress is kept here while it runs, so a quit can stop it. */
  loadTests?: Set<{ stop(): void }>
}

/** Collection variable changes made by scripts: a value, or null for a key a script unset. */
type Overrides = Map<string, string | null>

interface Open {
  info: WorkspaceInfo
  collections: CollectionStore
  environments: EnvironmentStore
  /** `pm.collectionVariables` changes by collection path; they last until the workspace is closed or switched. */
  sessionVariables: Map<string, Overrides>
  /** The collection run in progress, if any: at most one per workspace. */
  run?: RunHandle
  /** The load test in progress, if any: at most one per workspace, independent of the runner. */
  load?: LoadHandle
}

/** One request to send: as `http.send` gets it, or as the runner loaded it, with the runner's extras. */
interface SendInput {
  /** As edited or saved, variables unresolved. */
  request: RequestItem
  collection: CollectionTree | undefined
  /** The request's file; locates its folders' scripts. */
  requestPath: unknown
  environmentId: string | null
  signal: AbortSignal
  /** The runner's data row; `{}` outside the runner. */
  iterationData?: Record<string, unknown>
  info?: { iteration: number; iterationCount: number }
  /** Variable changes go here instead of to disk and the session (runner, keepVariables off). */
  overlay?: VariableOverlay | null
  /** When given, receives the URL sent (or the request's own when nothing was sent), secrets masked. */
  observe?: { url: string }
}

const GLOBALS_ID = 'globals'

const MAX_RECENT = 10

function isWorkspaceInfo(v: unknown): v is WorkspaceInfo {
  if (typeof v !== 'object' || v === null) return false
  const w = v as Record<string, unknown>
  return typeof w.id === 'string' && typeof w.name === 'string' && typeof w.dir === 'string'
}

async function readRecent(file: string): Promise<WorkspaceInfo[]> {
  try {
    const data = await readJson<unknown>(file)
    return Array.isArray(data) ? data.filter(isWorkspaceInfo).map(({ id, name, dir }) => ({ id, name, dir })) : []
  } catch {
    return []
  }
}

function enabledScope(variables: KeyValue[]): VariableScope {
  const scope: VariableScope = {}
  for (const v of variables) if (v.enabled) scope[v.key] = v.value
  return scope
}

/** `collections/<slug>/...` -> `collections/<slug>`. */
function collectionRoot(p: string): string {
  return p.split('/').slice(0, 2).join('/')
}

function withOverrides(scope: VariableScope, overrides: Overrides | undefined): VariableScope {
  const out = { ...scope }
  for (const [key, value] of overrides ?? []) {
    if (value === null) delete out[key]
    else out[key] = value
  }
  return out
}

/** What a script did to one scope: keys set to a new or changed value, and keys it removed. */
function changesOf(
  before: Record<string, string>,
  after: Record<string, string>,
): { set: Record<string, string>; unset: string[] } | null {
  const set: Record<string, string> = {}
  for (const [key, value] of Object.entries(after)) if (before[key] !== value) set[key] = value
  const unset = Object.keys(before).filter((key) => !Object.hasOwn(after, key))
  return Object.keys(set).length === 0 && unset.length === 0 ? null : { set, unset }
}

/** Records a script's changes to one scope: a value, or null for a key it removed. */
function applyChanges(
  target: Map<string, string | null> | undefined,
  changes: { set: Record<string, string>; unset: string[] } | null,
): void {
  if (!target || !changes) return
  for (const [key, value] of Object.entries(changes.set)) target.set(key, value)
  for (const key of changes.unset) target.set(key, null)
}

/** The overlay layer of the selected environment; the globals' own when the globals are selected. */
function environmentOverlay(
  overlay: VariableOverlay | null | undefined,
  environmentId: string | null,
): Overrides | undefined {
  if (!overlay || environmentId === null) return undefined
  return environmentId === GLOBALS_ID ? overlay.globals : overlay.environment
}

/** The values, in `scope`, of the secret variables of environment `id`. */
function secretValues(environments: Environment[], id: string | null, scope: VariableScope): string[] {
  const env = id === null ? undefined : environments.find((e) => e.id === id)
  return (env?.variables ?? []).filter((v) => v.secret && Object.hasOwn(scope, v.key)).map((v) => scope[v.key])
}

const REQUEST_SUFFIX = '.request.json'

/** The folder or request at `nodePath`, searched depth-first. */
function findNode(nodes: TreeNode[], nodePath: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === nodePath) return node
    if (node.kind === 'folder' && nodePath.startsWith(`${node.path}/`)) return findNode(node.children, nodePath)
  }
  return undefined
}

/** The requests under `nodes`, in tree order. */
function requestsIn(nodes: TreeNode[]): RequestNode[] {
  return nodes.flatMap((node) => (node.kind === 'folder' ? requestsIn(node.children) : [node]))
}

/** The folder at `folderPath`, searched depth-first. */
function findFolder(nodes: TreeNode[], folderPath: string): TreeNode[] | undefined {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue
    if (node.path === folderPath) return node.children
    if (folderPath.startsWith(`${node.path}/`)) return findFolder(node.children, folderPath)
  }
  return undefined
}

const scriptLabel = (kind: string, name: string) => `${kind} "${name}"`

/** The collection's scripts, then those of the folders holding `requestPath` (outer first), then the request's. */
function scriptSources(
  collection: CollectionTree | undefined,
  requestPath: unknown,
  request: RequestItem,
): ScriptSource[] {
  const sources: ScriptSource[] = []
  const add = (source: string, scripts: Scripts | undefined) => sources.push({ source, ...(scripts && { scripts }) })
  if (collection) {
    add(scriptLabel('Collection', collection.name), collection.scripts)
    if (typeof requestPath === 'string') {
      let nodes: TreeNode[] = collection.children
      for (;;) {
        const folder = nodes.find((n) => n.kind === 'folder' && requestPath.startsWith(`${n.path}/`))
        if (!folder || folder.kind !== 'folder') break
        add(scriptLabel('Folder', folder.name), folder.scripts)
        nodes = folder.children
      }
    }
  }
  add(scriptLabel('Request', request.name), request.scripts)
  return sources
}

export function createApi(deps: ApiDeps): AstralApi {
  const operations = deps.operations ?? new OperationTracker()
  /** Wraps a store method so a quit waits for calls of it that are still running. */
  const tracked =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      operations.track(fn(...args))
  let current: Open | null = null
  /** In-flight sends by the renderer's send id; each one can be cancelled on its own. */
  const inFlight = new Map<string, AbortController>()
  let recentQueue: Promise<unknown> = Promise.resolve()
  /** Imports run one at a time, so two globals files dropped together both merge into the globals. */
  let importQueue: Promise<unknown> = Promise.resolve()

  function serialImport<T>(fn: () => Promise<T>): Promise<T> {
    const result = importQueue.then(fn)
    importQueue = result.catch(() => undefined)
    return result
  }

  /** Git operations run one at a time, each on the workspace open when its turn comes. */
  let gitQueue: Promise<unknown> = Promise.resolve()

  function serialGit<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const result = gitQueue.then(async () => fn((await workspace()).info.dir))
    gitQueue = result.catch(() => undefined)
    return result
  }

  /** A git operation that changes the repository or the workspace's files: serialized, and a quit waits for it. */
  const gitOp =
    <A extends unknown[], R>(fn: (dir: string, ...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      operations.track(serialGit((dir) => fn(dir, ...args)))

  const trackWrite = <T>(write: Promise<T>): Promise<T> => operations.track(write)

  /** The save dialog; once it is answered, the workspace must still be the one it was opened for. */
  const pickExportPath =
    (before: Open) =>
    async (defaultName: string): Promise<string | null> => {
      const target = await deps.pickExportPath(defaultName)
      if (target !== null) await sameWorkspace(before)
      return target
    }

  /** Save dialog, then writes `json` there; the dialog is not tracked, as a quit must not wait for an answer. */
  async function saveReport(json: string, defaultName: string): Promise<string | null> {
    if (typeof json !== 'string' || typeof defaultName !== 'string') throw new Error('invalid_argument')
    const before = await workspace()
    const target = await pickExportPath(before)(defaultName)
    if (target === null) return null
    await trackWrite(fs.writeFile(target, json, 'utf8'))
    return target
  }

  /** After a dialog: the workspace must still be the one the dialog was opened for. */
  async function sameWorkspace(before: Open): Promise<Open> {
    const ws = await workspace()
    if (ws !== before) throw new Error('workspace_changed')
    return ws
  }

  /**
   * Also stops the workspace's collection run, which emits its `finished` event before this returns, and its load
   * test, whose `finished` event follows once the workers have wound down.
   */
  const cancelAllSends = (): void => {
    for (const controller of inFlight.values()) controller.abort()
    inFlight.clear()
    if (current?.run) {
      current.run.stop()
      current.run = undefined
    }
    if (current?.load) {
      current.load.stop()
      current.load = undefined
    }
  }

  /** Returns the open workspace, rejecting if none is open or its folder has disappeared. */
  async function workspace(): Promise<Open> {
    if (!current) throw new Error('no_workspace_open')
    try {
      await fs.access(path.join(current.info.dir, 'workspace.json'))
    } catch {
      throw new Error(`workspace_unavailable: cannot read workspace "${current.info.name}" at ${current.info.dir}`)
    }
    return current
  }

  function remember(info: WorkspaceInfo): void {
    // Best effort: failing to record history must not fail opening a workspace.
    recentQueue = recentQueue
      .then(async () => {
        const rest = (await readRecent(deps.recentFile)).filter((w) => w.dir !== info.dir)
        await writeJsonAtomic(deps.recentFile, [info, ...rest].slice(0, MAX_RECENT))
      })
      .catch(() => undefined)
  }

  async function activate(info: WorkspaceInfo): Promise<WorkspaceInfo> {
    cancelAllSends()
    current = {
      info,
      collections: new CollectionStore(info.dir),
      environments: new EnvironmentStore(info.dir, deps.cipher),
      sessionVariables: new Map(),
    }
    remember(info)
    await recentQueue
    return info
  }

  async function findCollection(ws: Open, collectionPath: string | null): Promise<CollectionTree | undefined> {
    if (collectionPath === null) return undefined
    try {
      const root = collectionRoot(collectionPath)
      return (await ws.collections.list()).collections.find((c) => c.path === root)
    } catch {
      return undefined
    }
  }

  async function environmentValues(ws: Open, id: string | null): Promise<VariableScope> {
    if (id === null) return {}
    try {
      return await ws.environments.resolvedValues(id)
    } catch {
      // A deleted or unreadable environment is treated as having no values.
      return {}
    }
  }

  async function listEnvironments(ws: Open): Promise<Environment[]> {
    try {
      return (await ws.environments.list()).environments
    } catch {
      // Unreadable environments are treated as having no values.
      return []
    }
  }

  /**
   * The send of one request, for `http.send` and the runner: through the scripts pipeline when any script would run,
   * else resolved and sent directly. Both paths resolve the runner's data row and read its variable overlay.
   */
  async function sendOne(ws: Open, s: SendInput): Promise<SendResult> {
    const collectionScope = collectionScopeOf(ws, s.collection, s.overlay)
    const sources = scriptSources(s.collection, s.requestPath, s.request)
    if (deps.scriptHost && hasScripts(sources)) {
      return sendWithScripts(ws, deps.scriptHost, s, collectionScope, sources)
    }
    const plain = await plainScopes(ws, s, collectionScope)
    const resolved = resolveRequest(withInheritedAuth(s.request, s.collection), plain.scopes)
    const result = await sendRequest(resolved, { signal: s.signal })
    if (s.observe) {
      const secrets = await plainSecrets(ws, s.environmentId, plain)
      s.observe.url = maskSecrets(result.ok ? result.response.finalUrl : requestUrl(resolved), secrets)
    }
    return result
  }

  /** The collection's enabled variables with the session's script changes, then the runner overlay's, on top. */
  function collectionScopeOf(
    ws: Open,
    collection: CollectionTree | undefined,
    overlay?: VariableOverlay | null,
  ): VariableScope {
    const overrides = collection ? ws.sessionVariables.get(collection.path) : undefined
    return withOverrides(withOverrides(enabledScope(collection?.variables ?? []), overrides), overlay?.collection)
  }

  /** The variable scopes of the plain path (no scripts), in resolution order. */
  async function plainScopes(
    ws: Open,
    s: Pick<SendInput, 'environmentId' | 'iterationData' | 'overlay'>,
    collectionScope: VariableScope,
  ): Promise<{ scopes: VariableScope[]; environment: VariableScope; globals: VariableScope }> {
    const envOverlay = environmentOverlay(s.overlay, s.environmentId)
    const environment = withOverrides(await environmentValues(ws, s.environmentId), envOverlay)
    const globals = withOverrides(await environmentValues(ws, GLOBALS_ID), s.overlay?.globals)
    const scopes = orderedScopes({
      data: dataScope(s.iterationData ?? {}),
      environment,
      collection: collectionScope,
      globals,
    })
    return { scopes, environment, globals }
  }

  /** The secret values the plain path resolved with, to mask in what is shown. */
  async function plainSecrets(
    ws: Open,
    environmentId: string | null,
    plain: { environment: VariableScope; globals: VariableScope },
  ): Promise<string[]> {
    const environments = await listEnvironments(ws)
    return [
      ...secretValues(environments, environmentId, plain.environment),
      ...secretValues(environments, GLOBALS_ID, plain.globals),
    ]
  }

  async function sendWithScripts(
    ws: Open,
    host: ScriptRunner,
    s: SendInput,
    collectionScope: VariableScope,
    sources: ScriptSource[],
  ): Promise<SendResult> {
    const environments = await listEnvironments(ws)
    const env = s.environmentId === null ? undefined : environments.find((e) => e.id === s.environmentId)
    const globals = environments.find((e) => e.id === GLOBALS_ID)
    const secretKeys = (e: Environment | undefined) => e?.variables.filter((v) => v.secret).map((v) => v.key) ?? []
    const overlay = s.overlay ?? null
    const envOverlay = env ? environmentOverlay(overlay, env.id) : undefined
    const variables: ScriptVariables = {
      local: {},
      environment: env ? withOverrides(valuesOf(env), envOverlay) : null,
      collection: collectionScope,
      globals: withOverrides(globals ? valuesOf(globals) : {}, overlay?.globals),
    }
    const collectionPath = s.collection?.path
    // For `observe`: the secret values the scripts started and ended with, and the main send's resolved URL.
    const secrets = new Set<string>()
    const noteSecrets = (vars: ScriptVariables) => {
      for (const key of secretKeys(env)) if (vars.environment?.[key] !== undefined) secrets.add(vars.environment[key])
      for (const key of secretKeys(globals)) if (vars.globals[key] !== undefined) secrets.add(vars.globals[key])
    }
    let sentUrl: string | undefined
    let mainSendNext = false
    const send: typeof sendRequest = (request, options) => {
      // `prepare` runs just before the main send is resolved; every other send is a `pm.sendRequest`.
      if (mainSendNext) {
        mainSendNext = false
        sentUrl = requestUrl(request)
      }
      return sendRequest(request, options)
    }
    const result = await runWithScripts(
      { host, send, ...(deps.scriptLimits && { limits: deps.scriptLimits }) },
      {
        request: s.request,
        sources,
        variables,
        ...(env && { environmentName: env.name }),
        ...(s.info && { info: s.info }),
        ...(s.iterationData && { iterationData: s.iterationData }),
        secretKeys: { environment: secretKeys(env), globals: secretKeys(globals) },
        prepare: (request) => {
          mainSendNext = true
          return withInheritedAuth(request, s.collection)
        },
        signal: s.signal,
        persist: (initial, final) => {
          noteSecrets(initial)
          noteSecrets(final)
          const collectionChanges = changesOf(initial.collection, final.collection)
          const envChanges = (before: VariableScope | null, after: VariableScope | null) =>
            before && after ? changesOf(before, after) : null
          if (overlay) {
            // Kept for the rest of the run only: nothing is written and no environment is reported as saved.
            if (collectionPath !== undefined) applyChanges(overlay.collection, collectionChanges)
            if (env) applyChanges(envOverlay, envChanges(initial.environment, final.environment))
            if (env?.id !== GLOBALS_ID) applyChanges(overlay.globals, envChanges(initial.globals, final.globals))
            return Promise.resolve([])
          }
          return operations.track(
            (async () => {
              const changed: string[] = []
              const write = async (id: string, before: VariableScope | null, after: VariableScope | null) => {
                const changes = envChanges(before, after)
                if (changes && (await ws.environments.setCurrentValues(id, changes))) changed.push(id)
              }
              if (collectionPath !== undefined && collectionChanges) {
                const overrides: Overrides = ws.sessionVariables.get(collectionPath) ?? new Map()
                applyChanges(overrides, collectionChanges)
                ws.sessionVariables.set(collectionPath, overrides)
              }
              if (env) await write(env.id, initial.environment, final.environment)
              if (env?.id !== GLOBALS_ID) await write(GLOBALS_ID, initial.globals, final.globals)
              return changed
            })(),
          )
        },
      },
    )
    if (s.observe) {
      const url = result.ok ? result.response.finalUrl : (sentUrl ?? s.request.url)
      s.observe.url = maskSecrets(url, secrets)
    }
    return result
  }

  function withInheritedAuth(request: RequestItem, collection: CollectionTree | undefined): RequestItem {
    if (request.auth.type !== 'inherit') return request
    const parent: Auth = collection?.auth ?? { type: 'none' }
    return { ...request, auth: parent.type === 'inherit' ? { type: 'none' } : parent }
  }

  return {
    workspace: {
      create: tracked(async (dir: string, name: string) => activate(await createWorkspace(dir, name))),
      open: tracked(async (dir: string) => activate(await openWorkspace(dir))),
      pickDirectory: () => deps.pickDirectory(),
      async close() {
        cancelAllSends()
        current = null
      },
      async reload() {
        const ws = await workspace()
        const info = await readWorkspaceInfo(ws.info.dir)
        // Only the workspace that was read takes the new info; one opened meanwhile keeps its own.
        if (current !== ws) return current ? current.info : info
        ws.info = info
        remember(info)
        await recentQueue
        return info
      },
      async recent() {
        await recentQueue
        const out: WorkspaceInfo[] = []
        for (const entry of await readRecent(deps.recentFile)) {
          try {
            // Read-only: listing must not touch (e.g. the .gitignore of) folders the user has not opened.
            out.push(await readWorkspaceInfo(entry.dir))
          } catch {
            // The folder is gone or no longer a workspace; leave it out.
          }
        }
        return out
      },
    },
    collections: {
      list: async () => (await workspace()).collections.list(),
      createCollection: tracked(async (name: string) => (await workspace()).collections.createCollection(name)),
      createFolder: tracked(async (parentPath: string, name: string) =>
        (await workspace()).collections.createFolder(parentPath, name),
      ),
      createRequest: tracked(async (parentPath: string, name: string) =>
        (await workspace()).collections.createRequest(parentPath, name),
      ),
      saveRequest: tracked(async (p: string, request: RequestItem, expectedRevision?: string) =>
        (await workspace()).collections.saveRequest(p, request, expectedRevision),
      ),
      rename: tracked(async (p: string, newName: string) => (await workspace()).collections.rename(p, newName)),
      remove: tracked(async (p: string) => (await workspace()).collections.remove(p)),
      move: tracked(async (p: string, newParentPath: string, index: number) =>
        (await workspace()).collections.move(p, newParentPath, index),
      ),
      updateSettings: tracked(
        async (p: string, patch: { scripts?: Scripts; variables?: KeyValue[]; auth?: Auth }) => {
          if (typeof p !== 'string') throw new Error('invalid_argument')
          await (await workspace()).collections.updateSettings(p, patch)
        },
      ),
    },
    environments: {
      list: async () => (await workspace()).environments.list(),
      save: tracked(async (env: Environment) => (await workspace()).environments.save(env)),
      remove: tracked(async (id: string) => (await workspace()).environments.remove(id)),
    },
    transfer: {
      // The dialogs are not tracked: a quit must not wait for the user to answer one.
      async importFiles() {
        const before = await workspace()
        const paths = await deps.pickImportFiles()
        if (paths.length === 0) return null
        const ws = await sameWorkspace(before)
        return tracked(() => serialImport(() => importFiles(ws, paths)))()
      },
      importText: tracked(async (text: string, source: string) => {
        if (typeof text !== 'string' || typeof source !== 'string') throw new Error('invalid_argument')
        const ws = await workspace()
        return serialImport(() => importText(ws, text, source))
      }),
      async exportCollection(collectionPath: string) {
        if (typeof collectionPath !== 'string') throw new Error('invalid_argument')
        const before = await workspace()
        return exportCollection(before, collectionPath, pickExportPath(before), trackWrite)
      },
      async exportEnvironment(id: string) {
        if (typeof id !== 'string') throw new Error('invalid_argument')
        const before = await workspace()
        return exportEnvironment(before, id, pickExportPath(before), trackWrite)
      },
    },
    http: {
      async send(request, context, sendId) {
        if (typeof sendId !== 'string' || sendId === '') throw new Error('invalid_send_id')
        const ws = await workspace()
        inFlight.get(sendId)?.abort()
        const controller = new AbortController()
        inFlight.set(sendId, controller)
        try {
          return await sendOne(ws, {
            request,
            collection: await findCollection(ws, context.collectionPath),
            requestPath: context.requestPath,
            environmentId: context.environmentId,
            signal: controller.signal,
          })
        } finally {
          if (inFlight.get(sendId) === controller) inFlight.delete(sendId)
        }
      },
      async cancel(sendId) {
        // An unknown or finished id is a no-op.
        if (typeof sendId !== 'string') return
        inFlight.get(sendId)?.abort()
        inFlight.delete(sendId)
      },
      async snippet(request, context, language) {
        const ws = await workspace()
        const collection = await findCollection(ws, context.collectionPath)
        const plain = await plainScopes(ws, { environmentId: context.environmentId }, collectionScopeOf(ws, collection))
        return snippet(resolveRequest(withInheritedAuth(request, collection), plain.scopes), language)
      },
    },
    runner: {
      async start(options) {
        const ws = await workspace()
        if (ws.run) throw new Error('runner_busy')
        /** The collection as it was when the run started; requests run as saved then. */
        let snapshot: { collection: CollectionTree; requests: Map<string, RequestItem> } | undefined
        const handle: RunHandle = startRun(
          {
            async loadPlan(planPath) {
              const { collections, errors } = await ws.collections.list()
              const collection = collections.find((c) => c.path === collectionRoot(planPath))
              const children =
                planPath === collection?.path ? collection.children : findFolder(collection?.children ?? [], planPath)
              if (!collection || !children) throw new Error(`not_found: ${planPath}`)
              const plan: PlanEntry[] = []
              const requests = new Map<string, RequestItem>()
              const walk = (nodes: TreeNode[]) => {
                for (const node of nodes) {
                  if (node.kind === 'folder') walk(node.children)
                  else {
                    plan.push({ path: node.path, name: node.name, method: node.request.method })
                    requests.set(node.path, node.request)
                  }
                }
              }
              walk(children)
              for (const e of errors) {
                if (e.path.startsWith(`${planPath}/`) && e.path.endsWith(REQUEST_SUFFIX)) {
                  plan.push({ path: e.path, name: fileName(e.path), method: 'GET', loadError: e.message })
                }
              }
              snapshot = { collection, requests }
              return plan
            },
            async sendOne(input) {
              const request = snapshot?.requests.get(input.requestPath)
              if (!snapshot || !request) {
                return { ok: false, error: { code: 'not_found', message: 'Request not found' } }
              }
              const observe = { url: '' }
              const result = await sendOne(ws, {
                request,
                collection: snapshot.collection,
                requestPath: input.requestPath,
                environmentId: input.environmentId,
                signal: input.signal,
                iterationData: input.data,
                info: input.info,
                overlay: input.overlay,
                observe,
              })
              return { ...result, url: observe.url }
            },
            emit(event) {
              if (event.type === 'finished' && ws.run === handle) ws.run = undefined
              deps.emitRunEvent?.(event)
            },
            sleep: abortableSleep,
          },
          options,
        )
        ws.run = handle
        try {
          await handle.started
        } catch (e) {
          if (ws.run === handle) ws.run = undefined
          throw e
        }
        return handle.runId
      },
      async stop(runId) {
        // An unknown or finished run is a no-op.
        if (current?.run && current.run.runId === runId) {
          current.run.stop()
          current.run = undefined
        }
      },
      // The dialogs are not tracked: a quit must not wait for the user to answer one.
      async pickDataFile() {
        const file = deps.pickDataFile ? await deps.pickDataFile() : null
        if (file === null) return null
        const ext = path.extname(file).toLowerCase()
        const kind = ext === '.csv' ? 'csv' : ext === '.json' ? 'json' : null
        if (kind === null) throw new Error('The data file must be a .csv or .json file')
        const tooBig = () => new Error('The data file is larger than 10 MB')
        const handle = await fs.open(file, 'r')
        let bytes: Buffer
        try {
          if ((await handle.stat()).size > MAX_DATA_BYTES) throw tooBig()
          bytes = await handle.readFile()
        } finally {
          await handle.close()
        }
        // The file may have grown between the check and the read.
        if (bytes.length > MAX_DATA_BYTES) throw tooBig()
        return { name: path.basename(file), rows: parseDataFile(bytes.toString('utf8'), kind) }
      },
      saveReport,
    },
    load: {
      async start(options) {
        const ws = await workspace()
        validateLoadOptions(options)
        if (ws.load) throw new Error('load_busy')
        const spawnWorker = deps.spawnLoadWorker
        if (!spawnWorker) throw new Error('load_unavailable')
        const { collections } = await ws.collections.list()
        const collection = collections.find((c) => c.path === collectionRoot(options.path))
        const node = collection && collection.path !== options.path ? findNode(collection.children, options.path) : null
        if (!collection || node === undefined) throw new Error(`not_found: ${options.path}`)
        const nodes =
          node === null
            ? requestsIn(collection.children)
            : node.kind === 'folder'
              ? requestsIn(node.children)
              : [node]
        if (nodes.length === 0) throw new Error('no_requests')
        // Resolved once, as Send's plain path resolves: scripts are not run.
        const plain = await plainScopes(ws, { environmentId: options.environmentId }, collectionScopeOf(ws, collection))
        const requests = nodes.map((n) => resolveRequest(withInheritedAuth(n.request, collection), plain.scopes))
        const secrets = await plainSecrets(ws, options.environmentId, plain)
        const displayUrls = requests.map((r) => maskSecrets(requestUrl(r), secrets))
        await sameWorkspace(ws)
        if (ws.load) throw new Error('load_busy')
        const handle: LoadHandle = startLoad(
          {
            spawnWorker,
            emit(event) {
              // `started` is emitted before startLoad returns, so `handle` is only read for `finished`.
              if (event.type === 'finished' && ws.load === handle) ws.load = undefined
              deps.emitLoadEvent?.(event)
            },
            now: () => performance.now(),
          },
          { requests, displayUrls },
          options,
        )
        ws.load = handle
        deps.loadTests?.add(handle)
        void handle.done.then(() => deps.loadTests?.delete(handle))
        return handle.testId
      },
      async stop(testId) {
        // An unknown or finished test is a no-op.
        const handle = current?.load
        if (!current || !handle || handle.testId !== testId) return
        current.load = undefined
        handle.stop()
        await handle.done
      },
      saveReport,
    },
    git: {
      state: () => serialGit(gitSync.readSyncState),
      link: gitOp(gitSync.link),
      unlink: gitOp(gitSync.unlink),
      // Not tracked: a quit need not wait for a background fetch, which changes no workspace file.
      fetch: () => serialGit(gitSync.fetch),
      async clone(remoteUrl: string) {
        if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '' || remoteUrl.trim().startsWith('-')) {
          throw new Error('Enter a repository URL')
        }
        // The dialog is not tracked: a quit must not wait for the user to answer it.
        const dir = await deps.pickDirectory('clone')
        if (dir === null) return null
        return tracked(async () => activate(await cloneWorkspace(dir, remoteUrl.trim())))()
      },
      setIdentity: gitOp(gitSync.setIdentity),
      commit: gitOp(gitSync.commit),
      sync: gitOp(gitSync.sync),
      pull: gitOp(gitSync.pull),
      push: gitOp(gitSync.push),
      resolve: gitOp(gitSync.resolve),
      async openInEditor(id: string) {
        const file = await serialGit((dir) => gitSync.conflictPath(dir, id))
        const error = deps.openPath ? await deps.openPath(file) : 'Opening files is not available'
        if (error) throw new Error(error)
      },
      finishMerge: gitOp(gitSync.finishMerge),
      abortMerge: gitOp(gitSync.abortMerge),
    },
    app: {
      async flushed() {
        deps.onFlushed?.()
      },
    },
  }
}
