# Scripts and Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-request and post-response scripts with a Postman-compatible `pm` API and `pm.test` / `pm.expect`
tests. Scripts run on every Send. The UI shows test results and a console, and lets the user edit scripts on
requests, folders and collections.

**Architecture:**

- **Where scripts run.** Scripts run in the main process, inside a QuickJS WebAssembly VM hosted in a Node
  `worker_threads` worker. The worker has no Node, no filesystem and no network access. Its only host functions
  are console, timers and `pm.sendRequest`.
- **The `pm` runtime.** It is plain JavaScript evaluated inside the VM. It takes JSON in (request, variables,
  response) and gives JSON out (mutations, test results, logs).
- **The send pipeline.** `http.send` in main runs scripts in this order, as Postman does:
  1. collection, folders and request pre-request scripts;
  2. variable resolution and the send itself;
  3. collection, folders and request post-response scripts.

  It then persists the variable changes and returns a script report along with the response.

**Tech Stack:** Electron 44 and TypeScript strict, plus the new dependencies `quickjs-emscripten-core` 0.32.0,
`@jitl/quickjs-wasmfile-release-sync` 0.32.0 (MIT), `chai` 6.2.2 (MIT, no dependencies) and
`@codemirror/lang-javascript` 6.2.5 (MIT).

**Spec:** `docs/superpowers/specs/2026-10-20-astral-maria-design.md`, decision 5. This plan deviates from it in one
way. Instead of "worker with `vm`", scripts run in QuickJS inside a worker. Node's `vm` is explicitly not a security
boundary, and scripts arrive from imported collections, so a script that escaped `vm` would get full Node access.
QuickJS shares no objects with the host and supports hard memory limits and interruption.

**UI binding:** `docs/superpowers/specs/2026-10-21-postman-measurements.md`. The UI spec deferred the Scripts and
Tests tabs to this plan.

## Global Constraints

- No code, text or icons copied from Postman. The `pm` API is reimplemented from its public documentation.
- Exact versions, pinned without `^`: `quickjs-emscripten-core@0.32.0`, `@jitl/quickjs-wasmfile-release-sync@0.32.0`,
  `chai@6.2.2`, `@codemirror/lang-javascript@6.2.5`. They go in `devDependencies`, like every other bundled renderer
  or main dependency in this repo. Check that electron-vite bundles them, and that the `.wasm` file is emitted and
  loadable. Copy it with `?url`/asset handling, or load it by path in the worker; your choice, documented.
- **Limits.**
  - Per script: 64 MB of VM memory.
  - Per script: 10 s of CPU, enforced by an interrupt handler.
  - Per script: 60 s of wall time, including pending timers and `pm.sendRequest` calls.
  - Cancelling a send also stops its scripts.
- **The two failure messages** (`<api>` stands for the name the script used):
  - An unsupported `pm.*` member: `pm.<api> is not supported in Astral Maria`.
  - `require(...)`: `require('<name>') is not supported in Astral Maria`.
- Variable values are strings. `set` converts its argument: strings stay as they are, `undefined` and `null` become
  `''`, objects and arrays go through `JSON.stringify`, and anything else through `String()`.
- **Where `set` writes.**
  - `pm.environment.set` and `pm.globals.set` change the current value. On disk that is the `.local` value; a key
    that does not exist yet is created with an empty initial value and the current value set, and the change is
    persisted.
  - `pm.collectionVariables.set` lives in main-process memory per collection until the workspace closes. It never
    writes `collection.json`.
  - `pm.variables.set` lives only for the current send, across its pre- and post-response scripts.
- **Resolution order**, highest first: send-local (`pm.variables`), environment, collection (session overrides on
  top of the file), globals.
- Commits are conventional. They end with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01W7UnCdyUfoFmAZKAA878zM
  ```

  Check that `git config user.email` is `stas.lisavoy@icloud.com`. Never change the identity, and never push.
- Implementers run only `npm test` and `npm run typecheck`. Never run `build`, `e2e`, `dev`, or anything that
  launches Electron.
- Branch: `feat/scripts`, cut from `main`.

## Review Focus

1. A script `while (true) {}` stops after the CPU limit with `Script timed out after 10 s`. The app stays
   responsive, and the request is not sent (pre-request) or the remaining scripts still run (post-response). *Test in
   Task 1 and Task 3.*
2. A script that throws, such as `pm.response.json()` on HTML, is reported with the script's location
   (`Post-response script of "Get user"`) and message. The other post-response scripts and the response itself are
   still shown. *Test in Task 3.*
3. Requests without any scripts take a fast path that never starts the VM. *Test in Task 3.*
4. `pm.environment.set` with no active environment fails with
   `pm.environment.set: no environment is selected`, as Postman does. *Test in Task 2.*
5. A secret set by a script stays a secret. It is written encrypted to `.local`, and it is masked in the console
   when it appears in logged request headers. *Test in Task 3: the stored value is encrypted.*

---

### Task 1: Sandbox engine

**Files:**
- Create: `src/main/scripts/engine.ts` (in-process QuickJS runner, pure apart from the wasm),
  `src/main/scripts/worker.ts` (a `worker_threads` entry that wraps the engine),
  `src/main/scripts/host.ts` (the main-side client of the worker; one worker is reused and replaced after a timeout)
- Modify: `package.json`, `electron.vite.config.ts` (the worker entry and the wasm asset), `src/main/csp.ts` only if
  needed
- Test: `tests/main/scriptEngine.test.ts`

**Interfaces:**
```ts
// engine.ts
export interface EngineHooks {
  /** Bridges pm.sendRequest; the engine passes the raw Postman-style request and gets a plain response object. */
  sendRequest(raw: unknown): Promise<unknown>
}
export interface RunOptions { cpuMs: number; wallMs: number; memoryBytes: number; signal?: AbortSignal }
export interface RunOutput {
  /** JSON-serialisable value returned by the runtime's `__finish()`; see Task 2. */
  result: unknown
  logs: { level: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string }[]
  error?: { message: string; kind: 'error' | 'timeout' | 'memory' | 'cancelled' }
}
/** Evaluates `prelude` (the pm runtime), then `source` wrapped as a function body, with `input` exposed as a frozen JSON global `__input`. */
export function runScript(prelude: string, source: string, input: unknown, hooks: EngineHooks, opts: RunOptions): Promise<RunOutput>
// host.ts
export class ScriptHost {
  run(prelude: string, source: string, input: unknown, hooks: EngineHooks, opts: RunOptions): Promise<RunOutput>
  dispose(): Promise<void>
}
```

**Engine rules.**

- **`console.*`.** Each argument is formatted as follows: strings stay as they are, objects go through
  `JSON.stringify` with a circular-safe replacer, and everything else through `String`. The arguments are joined by
  spaces.
- **Timers.** `setTimeout`, `clearTimeout`, `setInterval` and `clearInterval` are provided. Intervals count as
  pending work.
- **Finishing.** The run finishes when the job queue, the timers and the outstanding `sendRequest` calls are all
  empty, or when a limit hits. `Promise` jobs are drained with `executePendingJobs`.
- **What is absent.** `require`, `process`, `fetch`, `XMLHttpRequest` and `import()` are not available.
- **`require` stub.** A global `require` stub throws the message from Global Constraints.

- [ ] **Step 1: Pin the versions and install the dependencies.** Confirm that `npm ls` shows the exact versions and
  `package-lock.json` is updated.
- [ ] **Step 2: Write failing tests** against `runScript`, in-process:
  - `console.log('a', {b: 1})` logs `a {"b":1}`.
  - A thrown `Error('x')` gives `error.message` `x` and kind `error`.
  - `while(true){}` gives kind `timeout` within `cpuMs + 1000`.
  - Allocating huge arrays gives kind `memory`.
  - `setTimeout(() => console.log('late'), 50)` logs `late` before finishing.
  - A `sendRequest` hook resolving after 20 ms delivers its value to the script's callback.
  - An aborted `signal` gives kind `cancelled`.
  - `require('fs')` gives the Global Constraints message.
  - `typeof process`, `typeof fetch` and `typeof require('x')` all fail or are `'undefined'`, as appropriate.
  - Two runs share no globals: one sets `globalThis.leak = 1`, and the second sees it `undefined`.
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement** `engine.ts` (sync QuickJS variant: interrupt handler, `setMemoryLimit`, a new context per
  run), then `worker.ts` and `host.ts`. A test drives `host.ts` with a real `worker_threads` worker if vitest can
  load it. If it cannot, document why and cover the host through an injected engine.
- [ ] **Step 5: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `feat(scripts): run scripts in an isolated QuickJS sandbox`

---

### Task 2: The `pm` runtime

**Files:**
- Create: `src/main/scripts/runtime/pm.js` (plain JS evaluated inside the VM; it bundles chai, which is loaded as
  source text), `src/main/scripts/prelude.ts` (builds the prelude string from `pm.js` and the chai source with
  `?raw` imports), `src/main/scripts/types.ts`
- Test: `tests/main/pmRuntime.test.ts` (runs through `runScript` from Task 1)

**Interfaces:**
```ts
// types.ts — the runtime's JSON contract
export interface ScriptInput {
  phase: 'pre-request' | 'post-response'
  info: { eventName: 'prerequest' | 'test'; requestName: string; requestId: string; iteration: number; iterationCount: number }
  request: RequestItem                       // as edited, variables unresolved
  variables: { local: Record<string, string>; environment: Record<string, string> | null; collection: Record<string, string>; globals: Record<string, string> }
  response?: { code: number; status: string; headers: [string, string][]; body: string; responseTime: number; responseSize: number; cookies: ParsedCookie[] }
}
export interface ScriptResult {
  request: RequestItem                       // after pm.request mutations (pre-request only)
  variables: ScriptInput['variables']        // after set/unset/clear
  tests: { name: string; passed: boolean; skipped: boolean; error?: string }[]
  nextRequest?: string | null                // postman.setNextRequest; null means stop
}
export const PRELUDE: string
```

**The `pm` surface.** The prelude reads `__input`, and the script ends by returning `__finish()`, which serialises
`ScriptResult`.

- **Variable scopes.** `pm.environment`, `pm.globals`, `pm.collectionVariables` and `pm.variables`.
  - They provide `get`, `set`, `unset`, `has`, `toObject`, `clear` (not on `pm.variables`) and
    `replaceIn(text)`.
  - `pm.variables.get` resolves in the order from Global Constraints.
  - `pm.environment.name` is provided.
- **`pm.request`.**
  - `method` can be read and assigned.
  - `url`: `toString()`, and `query` with `add({key,value})`, `upsert`, `remove(key)`, `get(key)`, `has`,
    `toObject`.
  - `headers`: `add`, `upsert`, `remove`, `get`, `has`, `toObject` and `each`. Header name matching ignores case.
  - `body`: `mode` and `raw` can be read, and `update(string | {mode:'raw', raw})` replaces them.
  - Assigning `pm.request.url = 'text'` replaces the URL and its params.
- **`pm.response`**, in post-response scripts only.
  - Fields: `code`, `status`, `responseTime`, `responseSize`, and `headers` (`get`, `has`, `toObject`, `each`).
  - Methods: `text()` and `json()`. On a body that is not JSON, `json()` throws
    `pm.response.json: the response body is not valid JSON`.
  - `cookies`, as below.
- **`pm.cookies`.** `get(name)`, `has(name)` and `toObject()`, from the response's cookies.
- **`pm.info`.** `eventName`, `requestName`, `requestId`, `iteration` and `iterationCount`.
- **`pm.test(name, fn)`.** Sync, or async when `fn` takes a `done` callback or returns a promise. It records
  passed or failed with the error message. `pm.test.skip(name)` records a skipped test.
- **`pm.expect`.** This is chai's `expect`.
- **Chai helpers on the response.** They are added through a chai plugin:
  - `pm.response.to.have.status(code | text)`
  - `to.be.ok` (status 200), `to.be.success` (2xx), `to.be.clientError` (4xx), `to.be.serverError` (5xx) and
    `to.be.error` (4xx or 5xx)
  - `to.have.header(name[, value])`
  - `to.have.body(text | RegExp)`
  - `to.have.jsonBody([path[, value]])`, where the path is dotted (`a.b.0.c`)
  - `to.be.json`
  - `to.not.*` also works.
- **`postman.setNextRequest(nameOrNull)`.** Recorded only; the runner plan uses it.
- **Legacy globals, still common in exported collections:**
  - `tests['name'] = bool`
  - `responseBody`, `responseCode.code`, `responseTime` and `responseHeaders`
  - `postman.setEnvironmentVariable`, `postman.getEnvironmentVariable`, `postman.clearEnvironmentVariable`,
    `postman.setGlobalVariable`, `postman.getGlobalVariable` and `postman.clearGlobalVariable`
- **Unsupported members.** `pm` is a Proxy, so reading an unknown `pm.<name>` throws the Global Constraints message.
  `pm.vault`, `pm.iterationData`, `pm.visualizer` and `pm.execution` are explicitly unsupported.
- **Without an active environment,** `pm.environment.get` returns `undefined`, and `pm.environment.set` throws
  `pm.environment.set: no environment is selected`.
- **Writes in post-response scripts.** In `post-response`, `pm.request` mutations are ignored: the request was
  already sent. A warning is logged: `pm.request changes in a post-response script have no effect`.

- [ ] **Step 1: Write failing tests**, one `describe` per bullet above, each with its exact messages. They include:
  - The conversions from Global Constraints: `set('n', 5)` → `'5'`, `set('o', {a:1})` → `'{"a":1}'`.
  - Precedence: the same key in all four scopes resolves to the local one.
  - `replaceIn('{{a}}-{{missing}}')` → `'A-{{missing}}'`.
  - `pm.expect(1).to.equal(2)` fails with chai's message.
  - The response assertions pass and fail as described.
  - An async `pm.test` with `setTimeout` is recorded after it finishes.
  - Legacy `tests[...]` is recorded as a test.
  - `pm.foo` throws `pm.foo is not supported in Astral Maria`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `pm.js` and `prelude.ts`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(scripts): implement the pm API, tests and chai assertions`

---

### Task 3: Scripts in the send pipeline, and saving container settings

**Files:**
- Modify:
  - `src/shared/types.ts` and `src/shared/api.ts`
  - `src/main/api.ts`
  - `src/main/http/resolve.ts` (scope order)
  - `src/main/storage/collectionStore.ts`, `src/main/storage/environmentStore.ts`
  - `src/main/postman/importer.ts` (export the request conversion)
- Create: `src/main/scripts/pipeline.ts`
- Test: `tests/main/scriptPipeline.test.ts`, `tests/main/api.test.ts`, `tests/main/collectionStore.test.ts`

**Interfaces:**
```ts
// shared/types.ts
export interface ScriptLog { level: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string; phase: 'pre-request' | 'post-response'; source: string }
export interface ScriptTest { name: string; passed: boolean; skipped: boolean; error?: string; source: string }
export interface ScriptFailure { phase: 'pre-request' | 'post-response'; source: string; message: string }
export interface ScriptReport { tests: ScriptTest[]; logs: ScriptLog[]; failures: ScriptFailure[]; changedEnvironmentIds: string[] }
// SendResult gains `scripts?: ScriptReport` on both branches; a failed pre-request script gives
// { ok: false, error: { code: 'script_error', message }, scripts }.
// shared/api.ts
collections.updateSettings(path: string, patch: { scripts?: Scripts; variables?: KeyValue[]; auth?: Auth }): Promise<void>
//   path is a collection or folder; variables and auth only on a collection (else reject 'not_a_collection')
// importer.ts
export function fromPostmanRequest(raw: unknown, name: string): { request: Omit<RequestItem, 'id'>; warnings: string[] }
// pipeline.ts
export interface PipelineDeps { host: ScriptHost; send: typeof sendRequest; /* plus stores, cipher-backed env store */ }
export function runWithScripts(...): Promise<SendResult>   // signature is the implementer's choice, documented
```

**Pipeline rules:**

- **Where scripts come from.** They are taken in order from the collection, then each folder from outer to inner,
  then the request. A folder's scripts come from the tree returned by `list()`, located by the request path. A script
  whose text is empty or only whitespace is skipped. The `source` label is `Collection "X"`, `Folder "Y"` or
  `Request "Z"`.
- **How state flows through a phase.** Each script gets the request and variables that the previous one produced.
  In pre-request, the request after the last script is the one that gets resolved and sent.
- **When a pre-request script fails.** The remaining scripts do not run and nothing is sent. The result is
  `script_error` carrying the report.
- **When a post-response script fails.** It is recorded, and the following scripts still run.
- **Fast path.** If no script is non-empty, the existing send path runs unchanged and no `scripts` field is
  returned.
- **Persisting variables.**
  - After both phases (or after a pre-request failure), changes to environment and globals current values are saved.
    Save goes through the env store and changes only `currentValue`. A key the script created is added, and a key
    it unset is removed.
  - Secrets stay secret and are encrypted.
  - `changedEnvironmentIds` lists the environments that were written.
  - Collection variable changes go into the in-memory session map, keyed by collection path. Closing or switching
    the workspace clears it.
- **`pm.sendRequest`.**
  - The request is converted with `fromPostmanRequest`; a plain string means a GET.
  - Variables are resolved with the current scopes.
  - It is sent with `sendRequest` without running scripts.
  - The script receives `{ code, status, headers, body, responseTime, responseSize, cookies }`, from which the
    runtime builds a response object with `text()` and `json()`.
  - The same abort signal as the main send applies.
- **Cancel.** `http.cancel(sendId)` also aborts the running script.
- **Masking secrets in logs.** Before a log line is returned, every secret value of the active environment and of
  globals that is 4 or more characters long is replaced in its text with `••••`.

- [ ] **Step 1: Write failing tests.** Use a fake `ScriptHost` that runs the real engine in-process.
  - The order of sources across collection, folder and request, and that state carries over between scripts.
  - A pre-request header upsert reaches `sendRequest` (use a local HTTP test server like the existing
    `sendRequest` tests).
  - A pre-request failure is not sent and gives `script_error`.
  - A post-response failure lets later scripts run.
  - The fast path does not call the host.
  - `pm.environment.set` persists to `.local` and the committed file is unchanged; a secret is stored encrypted.
  - Collection session vars apply on the next send and are cleared on `workspace.close`.
  - `pm.sendRequest` round-trips through the test server.
  - A timeout script is reported as a failure, per Review Focus 1.
  - Masking works.
  - `collections.updateSettings` writes `scripts`, `variables` and `auth`. Folders reject `variables`. Changes to
    `order` are kept.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Create the `ScriptHost` once per app in `index.ts` and pass it into `createApi`
  through `ApiDeps`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(scripts): run collection, folder and request scripts around every send`

---

### Task 4: Request Scripts editor, Test Results and Console

**Files:**
- Modify:
  - `src/renderer/src/components/request/SectionNav.tsx` and `RequestEditor.tsx`
  - `src/renderer/src/components/CodeEditor.tsx` (a `javascript` language)
  - `src/renderer/src/components/ResponseViewer.tsx` and `response/*`
  - `src/renderer/src/components/StatusBar.tsx`
  - `src/renderer/src/state/store.ts` and `state/ui.ts`
  - `styles.css`, `tests/e2e/smoke.spec.ts`
- Create: `src/renderer/src/components/request/ScriptsPanel.tsx`, `src/renderer/src/components/ConsolePanel.tsx`
- Test: `tests/renderer/scriptsPanel.test.tsx`, `tests/renderer/responseViewer.test.tsx`, `tests/renderer/console.test.tsx`

**UI:**

- **Scripts section.** A `Scripts` request section is added after `Body` in SectionNav, plus `Settings` if one
  already exists. Inside it:
  - A left vertical list with `Pre-request` and `Post-response`. Each item shows a small dot when its script is
    non-empty.
  - On the right, a CodeMirror editor (JS mode, line numbers, the existing theme) bound to `draft.scripts`. Editing
    makes the draft dirty and autosaves like the other fields.
  - An empty script is stored by removing `scripts` when both scripts are empty.
- **Response tabs.** The response tabs get `Test Results`, which shows `Test Results (passed/total)` when the send
  had tests. Inside it:
  - A filter: `All`, `Passed`, `Skipped`, `Failed`.
  - Rows with a `PASS` / `FAIL` / `SKIP` badge (success, error or muted colour), the test name, the error message
    underneath on failures, and the source muted.
  - Empty state: `No tests for this request` plus a muted hint `Write tests in the Scripts tab with pm.test()`.
- **Script failures.** They show as an error strip above the response body:
  `Error in <phase> script of <source>: <message>`. On `script_error` with no response, the strip is shown in place
  of the response.
- **Console.**
  - A `Console` button in the status bar toggles a bottom panel (resizable, at least 120px, default 200px; its
    height is remembered in prefs).
  - The panel lists entries per send, newest last:
    - a request line `GET <resolved url> <status> <ms>`;
    - the log lines, coloured by level, with phase and source muted;
    - the failures.
  - It has `Clear` and a level filter, and keeps at most 500 entries.
- **Environments after a send.** When `changedEnvironmentIds` is non-empty, the store reloads environments. An open
  environment tab with no unsaved edits shows the new values. A tab with edits keeps the user's draft and shows the
  existing "changed on disk" notice.

- [ ] **Step 1: Write failing tests** for each bullet: editing marks the draft dirty and saves `scripts`; the dots;
  test counts and the filters; the failure strip; console toggle, entries, Clear and the 500 cap; environment
  reload on `changedEnvironmentIds`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Extend the e2e test** (written, not run). Write a pre-request script that does
  `pm.environment.set('token','abc')` and a test script that checks status 200 and
  `pm.environment.get('token') === 'abc'`. Send, then assert `Test Results (2/2)`. Save `ASTRAL_E2E_SHOTS` shots
  `f1-scripts-editor`, `f2-test-results` and `f3-console`.
- [ ] **Step 5: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `feat(ui): edit request scripts and show test results and the console`

---

### Task 5: Collection and folder settings tab

**Files:**
- Create: `src/renderer/src/components/ContainerEditor.tsx`
- Modify: `src/renderer/src/state/store.ts`, `lib/tabs.ts`, `TreeView.tsx`, `RequestTabs.tsx`, `styles.css`,
  `tests/e2e/smoke.spec.ts`
- Test: `tests/renderer/containerEditor.test.tsx`

**UI:**

- **Opening it.** Selecting a collection or a folder row opens a tab with it, as in Postman: Enter, or the new
  `Edit` menu item. A single click still expands or collapses the row. The tab id is the container's path, and its
  icon is a lucide `Folder` or `Library` icon.
- **Collection sections.** `Authorization` reuses AuthPanel without the `inherit` option. `Scripts` reuses
  ScriptsPanel. `Variables` uses KeyValueTable with Key | Value | Description.
- **Folder sections.** `Scripts` only, plus a muted note:
  `Folder authorization is inherited from the collection`.
- **Drafts.** Changes are drafts with the same dirty dot, the same Cmd/Ctrl+S, Save button and autosave as
  requests, and they save through `collections.updateSettings`.
- **Rename, move, delete.** These update or close the tab like request tabs do.
- **What a send uses.** Sends use the saved collection auth and variables, as they already do.

- [ ] **Step 1: Write failing tests:**
  - Opening the tab from the menu.
  - Editing and saving each section calls `updateSettings` with the right patch.
  - Folders show only Scripts.
  - Deleting the collection closes its tab.
  - Cmd+S saves.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Extend the e2e test** (written, not run):
  - Set a collection variable and a collection pre-request script that sets a header from it.
  - Send.
  - Assert that the echo server saw the header.
  - Save the shot `f4-collection-settings`.
- [ ] **Step 5: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `feat(ui): edit collection and folder scripts, variables and auth in a tab`
