import type {
  Auth,
  CollectionTree,
  Environment,
  FolderNode,
  ImportReport,
  KeyValue,
  LoadError,
  LoadEvent,
  LoadOptions,
  RequestItem,
  RequestNode,
  RunEvent,
  RunOptions,
  Scripts,
  SendResult,
  SnippetLanguage,
  SyncChoice,
  SyncOutcome,
  SyncState,
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
    /**
     * Re-reads the open workspace's `workspace.json` (a pull may bring in a new name) and updates the recent list,
     * without reopening it: sends, runs and session variables are untouched.
     */
    reload(): Promise<WorkspaceInfo>
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
    /**
     * Code in `language` that sends the request as Send would, variables resolved (secrets too) and inherited auth
     * applied; scripts are not run. Rejects with `unknown_language: <name>`.
     */
    snippet(
      request: RequestItem,
      context: { collectionPath: string | null; environmentId: string | null },
      language: SnippetLanguage,
    ): Promise<string>
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
  load: {
    /**
     * Starts a load test of a request, folder or collection; its requests are resolved once (environment, collection
     * variables, globals, inherited auth; no scripts). Resolves the test id once its `started` event was sent; progress
     * then arrives as LoadEvents. Rejects with `invalid_load_options: <field>`, `load_busy` (a test is in progress in
     * this workspace), `not_found: <path>` or `no_requests`. Closing or switching the workspace stops the test.
     */
    start(options: LoadOptions): Promise<string>
    /** Stops the test: its `finished` event (`stopped`) is sent before this resolves. An unknown id is a no-op. */
    stop(testId: string): Promise<void>
    /** Save dialog; writes `json` and resolves the path, or null when cancelled. */
    saveReport(json: string, defaultName: string): Promise<string | null>
  }
  /**
   * Syncing the open workspace with a git repository through the system `git`. Every method but `state` and
   * `openInEditor` rejects with `Finish or abort the merge first` while a merge is in progress (except the merge
   * methods themselves). Errors are user-facing messages.
   */
  git: {
    state(): Promise<SyncState>
    /**
     * Makes the workspace folder a repository (`git init`, also when it sits inside another repository), sets `origin`
     * and fetches. When the remote branch exists it is merged (unrelated histories allowed only here); a local
     * workspace with no commits is committed first. May end with conflicts, shown in the returned state.
     */
    link(remoteUrl: string): Promise<SyncState>
    /** Removes the `origin` remote only; the repository and its history stay. Refuses during a merge. */
    unlink(): Promise<SyncState>
    /** `git fetch` origin, then the state; updates `behind`. Merges nothing. */
    fetch(): Promise<SyncState>
    /**
     * Directory picker, then clones into the chosen empty folder and opens it as the workspace (creating
     * `workspace.json` when the repository has none). Null when the picker is cancelled.
     */
    clone(remoteUrl: string): Promise<WorkspaceInfo | null>
    /** Saves the commit identity for this repository only (`git config --local`). */
    setIdentity(name: string, email: string): Promise<void>
    /** Commits every change except `.local/`; a no-op when nothing changed. Rejects with `identity_missing`. */
    commit(message: string): Promise<void>
    /** Commits (when `message` is given), fetches, merges the remote, pushes. */
    sync(message: string | null): Promise<SyncOutcome>
    /** Fetches and merges; rejects when uncommitted changes touch files the remote changed. */
    pull(): Promise<SyncOutcome>
    /** Rejects with `The remote has new changes. Pull first` when the remote is ahead. */
    push(): Promise<SyncOutcome>
    /**
     * Resolves one conflict item (see `SyncConflictItem` for what each side means) and returns the new state. With
     * `edited` (a `file` item only) it rejects with `<label> still has conflict markers or is not valid JSON` unless
     * the working-tree file is free of conflict markers and, for a workspace JSON file, parses.
     */
    resolve(id: string, choice: SyncChoice): Promise<SyncState>
    /** Opens the conflicted file in the OS default editor. */
    openInEditor(id: string): Promise<void>
    /** Commits the merge once every item is resolved, then pushes if the merge came from a sync. */
    finishMerge(): Promise<SyncOutcome>
    /** `git merge --abort`: back to the state before the merge; commits made before it are kept. */
    abortMerge(): Promise<SyncState>
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
  /** A load test's progress (see `load.start`). Returns a function that removes the listener. */
  onLoadEvent(listener: (event: LoadEvent) => void): () => void
}

/** The channel main uses to send a flush request to the renderer. */
export const FLUSH_REQUEST_CHANNEL = 'astral:app.flush-request'

/** The channel main uses to push runner events to the renderer. */
export const RUN_EVENT_CHANNEL = 'astral:runner.event'

/** The channel main uses to push load test events to the renderer. */
export const LOAD_EVENT_CHANNEL = 'astral:load.event'

/** Method names per group; the preload and the main-process handlers are both generated from this table. */
export const API_METHODS = {
  workspace: ['create', 'open', 'pickDirectory', 'recent', 'close', 'reload'],
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
  http: ['send', 'cancel', 'snippet'],
  runner: ['start', 'stop', 'pickDataFile', 'saveReport'],
  load: ['start', 'stop', 'saveReport'],
  git: [
    'state',
    'link',
    'unlink',
    'fetch',
    'clone',
    'setIdentity',
    'commit',
    'sync',
    'pull',
    'push',
    'resolve',
    'openInEditor',
    'finishMerge',
    'abortMerge',
  ],
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
