import type {
  CollectionTree,
  Environment,
  FolderNode,
  LoadError,
  RequestItem,
  RequestNode,
  SendResult,
  WorkspaceInfo,
} from './types'

export interface AstralApi {
  workspace: {
    create(dir: string, name: string): Promise<WorkspaceInfo>
    open(dir: string): Promise<WorkspaceInfo>
    pickDirectory(): Promise<string | null>
    recent(): Promise<WorkspaceInfo[]>
  }
  collections: {
    list(): Promise<{ collections: CollectionTree[]; errors: LoadError[] }>
    createCollection(name: string): Promise<CollectionTree>
    createFolder(parentPath: string, name: string): Promise<FolderNode>
    createRequest(parentPath: string, name: string): Promise<RequestNode>
    saveRequest(path: string, request: RequestItem): Promise<void>
    rename(path: string, newName: string): Promise<string>
    remove(path: string): Promise<void>
    move(path: string, newParentPath: string, index: number): Promise<string>
  }
  environments: {
    list(): Promise<{ environments: Environment[]; errors: LoadError[] }>
    save(env: Environment): Promise<void>
    remove(id: string): Promise<void>
  }
  http: {
    /** `sendId` identifies this send (one per send per tab) so it can be cancelled on its own. */
    send(
      request: RequestItem,
      context: { collectionPath: string | null; environmentId: string | null },
      sendId: string,
    ): Promise<SendResult>
    /** Cancels the send with this id; an unknown or finished id is a no-op. */
    cancel(sendId: string): Promise<void>
  }
}

/** Method names per group; the preload and the main-process handlers are both generated from this table. */
export const API_METHODS = {
  workspace: ['create', 'open', 'pickDirectory', 'recent'],
  collections: ['list', 'createCollection', 'createFolder', 'createRequest', 'saveRequest', 'rename', 'remove', 'move'],
  environments: ['list', 'save', 'remove'],
  http: ['send', 'cancel'],
} as const satisfies { [G in keyof AstralApi]: readonly (keyof AstralApi[G] & string)[] }

export function channelName(group: string, method: string): string {
  return `astral:${group}.${method}`
}

/** Every IPC channel, e.g. `astral:workspace.open`. */
export const CHANNELS: readonly string[] = Object.entries(API_METHODS).flatMap(([group, methods]) =>
  methods.map((m) => channelName(group, m)),
)

/** Electron wraps handler errors as "Error invoking remote method '<channel>': Error: <message>"; recover the message. */
export function unwrapIpcError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e)
  return new Error(message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''))
}

declare global {
  interface Window {
    astral: AstralApi
  }
}
