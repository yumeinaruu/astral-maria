import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AstralApi } from '../shared/api'
import type {
  Auth,
  CollectionTree,
  Environment,
  KeyValue,
  RequestItem,
  Scripts,
  TreeNode,
  WorkspaceInfo,
} from '../shared/types'
import { OperationTracker } from './flushGuard'
import { orderedScopes, resolveRequest, type VariableScope } from './http/resolve'
import { sendRequest } from './http/sendRequest'
import { hasScripts, runWithScripts, type ScriptLimits, type ScriptRunner, type ScriptSource } from './scripts/pipeline'
import type { ScriptVariables } from './scripts/types'
import { CollectionStore } from './storage/collectionStore'
import { EnvironmentStore, valuesOf, type SecretCipher } from './storage/environmentStore'
import { readJson, writeJsonAtomic } from './storage/fsJson'
import { createWorkspace, openWorkspace, readWorkspaceInfo } from './storage/workspaceStore'
import { exportCollection, exportEnvironment, importFiles, importText } from './transfer'

export interface ApiDeps {
  cipher: SecretCipher
  pickDirectory: () => Promise<string | null>
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
}

/** Collection variable changes made by scripts: a value, or null for a key a script unset. */
type Overrides = Map<string, string | null>

interface Open {
  info: WorkspaceInfo
  collections: CollectionStore
  environments: EnvironmentStore
  /** `pm.collectionVariables` changes by collection path; they last until the workspace is closed or switched. */
  sessionVariables: Map<string, Overrides>
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

  const trackWrite = <T>(write: Promise<T>): Promise<T> => operations.track(write)

  /** The save dialog; once it is answered, the workspace must still be the one it was opened for. */
  const pickExportPath =
    (before: Open) =>
    async (defaultName: string): Promise<string | null> => {
      const target = await deps.pickExportPath(defaultName)
      if (target !== null) await sameWorkspace(before)
      return target
    }

  /** After a dialog: the workspace must still be the one the dialog was opened for. */
  async function sameWorkspace(before: Open): Promise<Open> {
    const ws = await workspace()
    if (ws !== before) throw new Error('workspace_changed')
    return ws
  }

  const cancelAllSends = (): void => {
    for (const controller of inFlight.values()) controller.abort()
    inFlight.clear()
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

  async function sendWithScripts(
    ws: Open,
    host: ScriptRunner,
    send: {
      request: RequestItem
      collection: CollectionTree | undefined
      collectionScope: VariableScope
      sources: ScriptSource[]
      environmentId: string | null
      signal: AbortSignal
    },
  ) {
    let environments: Environment[] = []
    try {
      environments = (await ws.environments.list()).environments
    } catch {
      // Unreadable environments are treated as having no values, as on the plain path.
    }
    const env = send.environmentId === null ? undefined : environments.find((e) => e.id === send.environmentId)
    const globals = environments.find((e) => e.id === GLOBALS_ID)
    const secretKeys = (e: Environment | undefined) => e?.variables.filter((v) => v.secret).map((v) => v.key) ?? []
    const variables: ScriptVariables = {
      local: {},
      environment: env ? valuesOf(env) : null,
      collection: send.collectionScope,
      globals: globals ? valuesOf(globals) : {},
    }
    const collectionPath = send.collection?.path
    return runWithScripts(
      { host, send: sendRequest, ...(deps.scriptLimits && { limits: deps.scriptLimits }) },
      {
        request: send.request,
        sources: send.sources,
        variables,
        ...(env && { environmentName: env.name }),
        secretKeys: { environment: secretKeys(env), globals: secretKeys(globals) },
        prepare: (request) => withInheritedAuth(request, send.collection),
        signal: send.signal,
        persist: (initial, final) =>
          operations.track(
            (async () => {
              const changed: string[] = []
              const write = async (id: string, before: VariableScope | null, after: VariableScope | null) => {
                const changes = before && after ? changesOf(before, after) : null
                if (changes && (await ws.environments.setCurrentValues(id, changes))) changed.push(id)
              }
              const collectionChanges = changesOf(initial.collection, final.collection)
              if (collectionPath !== undefined && collectionChanges) {
                const overrides: Overrides = ws.sessionVariables.get(collectionPath) ?? new Map()
                for (const [key, value] of Object.entries(collectionChanges.set)) overrides.set(key, value)
                for (const key of collectionChanges.unset) overrides.set(key, null)
                ws.sessionVariables.set(collectionPath, overrides)
              }
              if (env) await write(env.id, initial.environment, final.environment)
              if (env?.id !== GLOBALS_ID) await write(GLOBALS_ID, initial.globals, final.globals)
              return changed
            })(),
          ),
      },
    )
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
          const collection = await findCollection(ws, context.collectionPath)
          const overrides = collection ? ws.sessionVariables.get(collection.path) : undefined
          const collectionScope = withOverrides(enabledScope(collection?.variables ?? []), overrides)
          const sources = scriptSources(collection, context.requestPath, request)
          if (!deps.scriptHost || !hasScripts(sources)) {
            const scopes = orderedScopes({
              environment: await environmentValues(ws, context.environmentId),
              collection: collectionScope,
              globals: await environmentValues(ws, GLOBALS_ID),
            })
            const resolved = resolveRequest(withInheritedAuth(request, collection), scopes)
            return await sendRequest(resolved, { signal: controller.signal })
          }
          return await sendWithScripts(ws, deps.scriptHost, {
            request,
            collection,
            collectionScope,
            sources,
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
    },
    app: {
      async flushed() {
        deps.onFlushed?.()
      },
    },
  }
}
