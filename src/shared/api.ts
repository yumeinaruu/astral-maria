import type {
  Auth,
  CollectionTree,
  Environment,
  FolderNode,
  ImportReport,
  KeyValue,
  LoadError,
  RequestItem,
  RequestNode,
  RunEvent,
  RunOptions,
  Scripts,
  SendResult,
  WorkspaceInfo,
} from './types'

export interface AstralApi {
  workspace: {
    create(dir: string, name: string): Promise<WorkspaceInfo>
    open(dir: string): Promise<WorkspaceInfo>
    pickDirectory(): Promise<string | null>
    recent(): Promise<WorkspaceInfo[]>
    /** Cancels sends in flight and closes the open workspace (if any); the renderer flushes its drafts first. */
    close(): Promise<void>
  }
  collections: {
    list(): Promise<{ collections: CollectionTree[]; errors: LoadError[] }>
    createCollection(name: string): Promise<CollectionTree>
    createFolder(parentPath: string, name: string): Promise<FolderNode>
    createRequest(parentPath: string, name: string): Promise<RequestNode>
    /**
     * Writes the request and resolves with its new revision. With `expectedRevision` it rejects with
     * `changed_on_disk` (writing nothing) if the file no longer has that revision.
     */
    saveRequest(path: string, request: RequestItem, expectedRevision?: string): Promise<string>
    rename(path: string, newName: string): Promise<string>
    remove(path: string): Promise<void>
    move(path: string, newParentPath: string, index: number): Promise<string>
    /**
     * Saves the settings of a collection or folder; only the fields given change. `variables` and `auth` exist only
     * on a collection: on a folder they reject with `not_a_collection`.
     */
    updateSettings(path: string, patch: { scripts?: Scripts; variables?: KeyValue[]; auth?: Auth }): Promise<void>
  }
  environments: {
    list(): Promise<{ environments: Environment[]; errors: LoadError[] }>
    save(env: Environment): Promise<void>
    remove(id: string): Promise<void>
  }
  transfer: {
    /** Open dialog for .json files (multi-select); imports each in order. Resolves null when cancelled. */
    importFiles(): Promise<ImportReport | null>
    /** One file's text, dropped or pasted; `source` names it in the report (file name or "Pasted text"). */
    importText(text: string, source: string): Promise<ImportReport>
    /** Save dialog, then writes Collection v2.1; resolves the written path, or null when cancelled. */
    exportCollection(collectionPath: string): Promise<string | null>
    /** Save dialog, then writes Postman's environment format (secrets empty); the written path, or null. */
    exportEnvironment(id: string): Promise<string | null>
  }
  http: {
    /**
     * `sendId` identifies this send (one per send per tab) so it can be cancelled on its own. Runs the collection's,
     * folders' and request's scripts around the send; `requestPath` (the request's file) locates its folders.
     */
    send(
      request: RequestItem,
      context: { collectionPath: string | null; environmentId: string | null; requestPath?: string | null },
      sendId: string,
    ): Promise<SendResult>
    /** Cancels the send with this id; an unknown or finished id is a no-op. */
    cancel(sendId: string): Promise<void>
  }
  runner: {
    /**
     * Starts a run of a collection or folder; resolves the run id once the run has started (its `started` event is
     * sent first). Results then arrive as RunEvents. Rejects with `invalid_run_options: <field>`, `runner_busy` (a run
     * is in progress in this workspace) or `not_found: <path>`. Closing or switching the workspace stops the run.
     */
    start(options: RunOptions): Promise<string>
    /** Stops the run: its `finished` event (`stopped`) is sent before this resolves. An unknown id is a no-op. */
    stop(runId: string): Promise<void>
    /** Open dialog for one .csv/.json file; parsed rows, or null when cancelled; rejects with the parse message. */
    pickDataFile(): Promise<{ name: string; rows: Record<string, unknown>[] } | null>
    /** Save dialog; writes `json` and resolves the path, or null when cancelled. */
    saveReport(json: string, defaultName: string): Promise<string | null>
  }
  app: {
    /** Acknowledges a flush request (see `AstralEvents.onFlushRequest`): every unsaved draft has been written. */
    flushed(): Promise<void>
  }
}

/** Main-to-renderer notifications, exposed as `window.astralEvents`. */
export interface AstralEvents {
  /**
   * The app is about to quit or the window to close: write every unsaved draft, then call `app.flushed()`. Returns a
   * function that removes the listener.
   */
  onFlushRequest(listener: () => void): () => void
  /** A collection run's progress (see `runner.start`). Returns a function that removes the listener. */
  onRunEvent(listener: (event: RunEvent) => void): () => void
}

/** The channel main uses to send a flush request to the renderer. */
export const FLUSH_REQUEST_CHANNEL = 'astral:app.flush-request'

/** The channel main uses to push runner events to the renderer. */
export const RUN_EVENT_CHANNEL = 'astral:runner.event'

/** Method names per group; the preload and the main-process handlers are both generated from this table. */
export const API_METHODS = {
  workspace: ['create', 'open', 'pickDirectory', 'recent', 'close'],
  collections: [
    'list',
    'createCollection',
    'createFolder',
    'createRequest',
    'saveRequest',
    'rename',
    'remove',
    'move',
    'updateSettings',
  ],
  environments: ['list', 'save', 'remove'],
  transfer: ['importFiles', 'importText', 'exportCollection', 'exportEnvironment'],
  http: ['send', 'cancel'],
  runner: ['start', 'stop', 'pickDataFile', 'saveReport'],
  app: ['flushed'],
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
    /** Missing only outside the app (e.g. in tests that do not install it). */
    astralEvents?: AstralEvents
  }
}
