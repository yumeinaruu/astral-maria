import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AstralApi } from '../shared/api'
import type { Auth, CollectionTree, KeyValue, RequestItem, WorkspaceInfo } from '../shared/types'
import { resolveRequest, type VariableScope } from './http/resolve'
import { sendRequest } from './http/sendRequest'
import { CollectionStore } from './storage/collectionStore'
import { EnvironmentStore, type SecretCipher } from './storage/environmentStore'
import { readJson, writeJsonAtomic } from './storage/fsJson'
import { createWorkspace, openWorkspace, readWorkspaceInfo } from './storage/workspaceStore'

export interface ApiDeps {
  cipher: SecretCipher
  pickDirectory: () => Promise<string | null>
  recentFile: string
}

interface Open {
  info: WorkspaceInfo
  collections: CollectionStore
  environments: EnvironmentStore
}

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

export function createApi(deps: ApiDeps): AstralApi {
  let current: Open | null = null
  /** In-flight sends by the renderer's send id; each one can be cancelled on its own. */
  const inFlight = new Map<string, AbortController>()
  let recentQueue: Promise<unknown> = Promise.resolve()

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

  async function valuesOf(ws: Open, id: string | null): Promise<VariableScope> {
    if (id === null) return {}
    try {
      return await ws.environments.resolvedValues(id)
    } catch {
      // A deleted or unreadable environment is treated as having no values.
      return {}
    }
  }

  function withInheritedAuth(request: RequestItem, collection: CollectionTree | undefined): RequestItem {
    if (request.auth.type !== 'inherit') return request
    const parent: Auth = collection?.auth ?? { type: 'none' }
    return { ...request, auth: parent.type === 'inherit' ? { type: 'none' } : parent }
  }

  return {
    workspace: {
      create: async (dir, name) => activate(await createWorkspace(dir, name)),
      open: async (dir) => activate(await openWorkspace(dir)),
      pickDirectory: () => deps.pickDirectory(),
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
      createCollection: async (name) => (await workspace()).collections.createCollection(name),
      createFolder: async (parentPath, name) => (await workspace()).collections.createFolder(parentPath, name),
      createRequest: async (parentPath, name) => (await workspace()).collections.createRequest(parentPath, name),
      saveRequest: async (p, request) => (await workspace()).collections.saveRequest(p, request),
      rename: async (p, newName) => (await workspace()).collections.rename(p, newName),
      remove: async (p) => (await workspace()).collections.remove(p),
      move: async (p, newParentPath, index) => (await workspace()).collections.move(p, newParentPath, index),
    },
    environments: {
      list: async () => (await workspace()).environments.list(),
      save: async (env) => (await workspace()).environments.save(env),
      remove: async (id) => (await workspace()).environments.remove(id),
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
          const scopes = [
            await valuesOf(ws, context.environmentId),
            enabledScope(collection?.variables ?? []),
            await valuesOf(ws, 'globals'),
          ]
          const resolved = resolveRequest(withInheritedAuth(request, collection), scopes)
          return await sendRequest(resolved, { signal: controller.signal })
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
  }
}
