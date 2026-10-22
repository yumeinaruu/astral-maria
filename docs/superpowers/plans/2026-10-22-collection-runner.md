# Collection Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a collection or folder with iterations, a delay and a CSV/JSON data file, honouring
`postman.setNextRequest`. Show live per-request and per-test results, and export the report as JSON.

**Architecture:**

- **Where the run happens.** The run loop lives in the main process (`src/main/runner/`) and reuses the
  scripts-and-send pipeline of `http.send` for each request.
- **Progress.** Main streams progress events to the renderer over one push channel, like the existing flush-request
  channel.
- **UI.** The renderer gets a Runner tab per collection or folder: configuration first, then live results.

**Tech Stack:** Electron 44, TypeScript strict, React 19, zustand, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-astral-maria-design.md`, Scope: "Collection runner: run a collection or
folder, with iterations, delay, and CSV/JSON data files; results list with per-test pass/fail; export the report as
JSON". Delivery item 4. **UI binding:** `docs/superpowers/specs/2026-10-21-postman-measurements.md`.

## Global Constraints

- No code, text or icons copied from Postman. Icons come from lucide.
- **What a run sends.**
  - Requests run from disk, as saved. The renderer flushes unsaved drafts before starting.
  - Each request runs through the same pipeline as Send: collection, then folder, then request scripts, then
    inherited auth, then variable resolution.
  - Masking and the CPU, memory and time limits all apply.
- **Run order** is depth-first in tree order, limited to the requests the user left selected.
- **Variable precedence**, highest first: send-local, iteration data, environment, collection (with session
  overrides), globals.
- **Data values.**
  - For resolution, data values are converted like `pm.environment.set` arguments: strings stay as they are, `null`
    and `undefined` become `''`, objects go through `JSON.stringify`, and anything else through `String`.
  - `pm.iterationData.get` returns the original JSON value.
- **Keep variable values.** On by default. When it is off, environment, globals and collection-session changes
  last only within the run and are never persisted. Scripts still see their own changes for the rest of the run.
- **Limits.**
  - At most one run per workspace at a time; a second `start` rejects with `runner_busy`.
  - Iterations: 1 to 10 000.
  - Delay: 0 to 600 000 ms.
  - Data file: at most 10 MB and 10 000 rows.
  - At most 10 000 request executions in one iteration, a guard against `setNextRequest` loops. Hitting it stops
    the run with reason `loop_guard`.
- **Commits** are conventional. They end with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01W7UnCdyUfoFmAZKAA878zM
  ```

  Check that `git config user.email` is `stas.lisavoy@icloud.com`. Never change the identity, and never push.
- Implementers run only `npm test` and `npm run typecheck`: no `build`, `e2e`, `dev` or Electron launch.
- **Branch:** `feat/runner`, cut from `main`.

## Review Focus

1. **Stopping mid-run.** Stop aborts the in-flight request or script at once. Results so far stay, and the summary
   says `Stopped`. Nothing more is sent afterwards. *Test in Task 2.*
2. **`setNextRequest` with a name that matches no request.** The run stops with reason
   `next_request_not_found: "<name>"`, rather than silently continuing. *Test in Task 2.*
3. **CSV edge cases.**
   - Parsed: quoted fields with commas, `""` escapes and newlines; CRLF; a BOM; a trailing newline.
   - Rows shorter than the header get `''` for the missing columns.
   - Rejected with a message: an empty file, and a header with duplicate names. *Test in Task 1.*
4. **Closing or switching the workspace during a run** stops the run, and no event arrives afterwards for the old
   workspace. *Test in Task 2.*
5. **A request whose file fails to load** is reported as a failed result (`error: <load message>`), and the run
   continues. *Test in Task 2.*

---

### Task 1: Iteration data in the scripts runtime, and data file parsing

**Files:**
- Modify:
  - `src/main/scripts/runtime/pm.js` and `src/main/scripts/types.ts`
  - `src/main/scripts/pipeline.ts`
  - `src/main/http/resolve.ts`
  - `src/shared/types.ts`
- Create: `src/main/runner/dataFile.ts`
- Test: `tests/main/pmRuntime.test.ts`, `tests/main/scriptPipeline.test.ts`, `tests/main/dataFile.test.ts`

**Interfaces:**
```ts
// scripts/types.ts — ScriptInput gains
iterationData: Record<string, unknown>          // {} outside the runner
// ScriptResult already has nextRequest?: string | null
// resolve.ts — NamedScopes gains `data?: VariableScope`, placed after `local` in orderedScopes
// pipeline.ts — PipelineRun gains
info?: { iteration: number; iterationCount: number }     // default 0 / 1
iterationData?: Record<string, unknown>                  // default {}
// shared/types.ts — ScriptReport gains
nextRequest?: string | null   // the last setNextRequest of this send's scripts; absent when none called it
// runner/dataFile.ts
export type DataRow = Record<string, unknown>
export const MAX_DATA_BYTES = 10 * 1024 * 1024
export const MAX_DATA_ROWS = 10_000
/** kind from the file extension (.csv / .json); throws an Error with a user-facing message. */
export function parseDataFile(text: string, kind: 'csv' | 'json'): DataRow[]
export function dataScope(row: DataRow): Record<string, string>   // the string conversion above
```

**The runtime surface.**

- **`pm.iterationData`** provides `get(key)`, `has(key)`, `toObject()`, `toJSON()` and `unset(key)`. `unset` only
  affects the rest of this script.
- **Data lookups.** `pm.variables.get` and `pm.variables.replaceIn` consult the data scope after local variables.
- **`legacy data`.** Exposed as a frozen copy of the row.
- **No longer unsupported.** Remove `pm.iterationData` from the unsupported list.

**`parseDataFile` rules.**

- **CSV.**
  - RFC 4180. The first row is the header. Header names are trimmed. A leading BOM is stripped.
  - Empty lines are skipped. A row longer than the header is an error:
    `Row <n> has <m> values but the header has <k>`.
  - Values stay strings.
- **JSON.**
  - An array of plain objects. Anything else is rejected:
    `The data file must be a JSON array of objects`.
  - Values are kept as they are.
- **Both formats.**
  - An empty result is rejected: `The data file has no rows`.
  - More than `MAX_DATA_ROWS` rows is rejected: `The data file has more than 10000 rows`.
  - Duplicate CSV header names are rejected: `Duplicate column "<name>"`.

- [ ] **Step 1: Write failing tests:**
  - **Runtime:** `pm.iterationData` get, has, toObject and unset; precedence when the same key is in `local`, data and
    environment; `replaceIn` with a data value; the legacy `data` global; `pm.info.iteration` and `iterationCount`
    reflect the input.
  - **Pipeline:** the `info` and `iterationData` options reach the scripts. `{{key}}` in the URL resolves from data.
    `nextRequest` appears in the report only when a script called `setNextRequest`, and the last call wins.
  - **`parseDataFile`:** every rule and message above, plus Review Focus 3.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(scripts): add iteration data and parse runner data files`

---

### Task 2: The run loop, IPC and events

**Files:**
- Create: `src/main/runner/runner.ts`
- Modify:
  - `src/main/api.ts`: factor the per-request send of `sendWithScripts` and the plain path into one function the
    runner can call with `data`, `info`, `keepVariables` and a signal.
  - `src/main/index.ts`: dialogs, the event channel, e2e hooks.
  - `src/shared/api.ts`, `src/shared/types.ts`, `src/preload/index.ts`
- Test: `tests/main/runner.test.ts`, `tests/main/api.test.ts`

**Interfaces:**
```ts
// shared/types.ts
export interface RunOptions {
  /** A collection or folder path. */
  path: string
  /** Request paths to run, in tree order; requests not listed are skipped. */
  requestPaths: string[]
  environmentId: string | null
  iterations: number
  delayMs: number
  data: { name: string; rows: Record<string, unknown>[] } | null
  keepVariables: boolean
  stopOnError: boolean
}
export interface RunResult {
  iteration: number              // 0-based
  path: string
  name: string
  method: HttpMethod
  url: string                    // final URL, secrets masked
  status?: number
  statusText?: string
  timeMs?: number
  sizeBytes?: number
  tests: ScriptTest[]
  failures: ScriptFailure[]
  error?: string                 // send error, load error or script_error message
}
export type StopReason = 'completed' | 'stopped' | 'error' | 'loop_guard' | `next_request_not_found: "${string}"`
export type RunEvent =
  | { runId: string; type: 'started'; total: number; startedAt: string }
  | { runId: string; type: 'result'; result: RunResult }
  | { runId: string; type: 'finished'; reason: StopReason; durationMs: number }
// shared/api.ts — new group `runner`
runner: {
  /** Resolves the run id once the run has started; results then arrive as RunEvents. */
  start(options: RunOptions): Promise<string>
  stop(runId: string): Promise<void>
  /** Open dialog for one .csv/.json file; parsed rows, or null when cancelled; rejects with the parse message. */
  pickDataFile(): Promise<{ name: string; rows: Record<string, unknown>[] } | null>
  /** Save dialog; writes `json` and resolves the path, or null when cancelled. */
  saveReport(json: string, defaultName: string): Promise<string | null>
}
// AstralEvents gains onRunEvent(listener: (e: RunEvent) => void): () => void, on channel RUN_EVENT_CHANNEL = 'astral:runner.event'
// runner.ts
export interface RunnerDeps {
  sendOne(input: { requestPath: string; environmentId: string | null; data: Record<string, unknown>; info: { iteration: number; iterationCount: number }; overlay: VariableOverlay | null; signal: AbortSignal }): Promise<SendResult>
  loadPlan(path: string): Promise<{ path: string; name: string; method: HttpMethod; loadError?: string }[]>
  emit(event: RunEvent): void
  sleep(ms: number, signal: AbortSignal): Promise<void>
}
/** In-memory variable layer for keepVariables === false; sendOne reads it on top of disk and writes changes into it instead of persisting. */
export interface VariableOverlay { environment: Map<string, string | null>; globals: Map<string, string | null>; collection: Map<string, string | null> }
export function startRun(deps: RunnerDeps, options: RunOptions): { runId: string; done: Promise<void>; stop(): void }
```

**Loop rules.**

- **Iterations.** Each iteration `i` from 0 to `iterations - 1` uses data row `i % rows.length`, or `{}` when there is
  no data.
- **Inside an iteration.** It walks the selected requests in order. After each request, `report.nextRequest` decides
  what comes next:
  - `undefined`: the next request in order;
  - `null`: stop the whole run with reason `completed`, as Postman does;
  - a name: jump to the first selected request with that name, or stop with `next_request_not_found`.
- **Delay.** `delayMs` is slept between two consecutive requests, but not after the last one. The sleep can be
  cancelled.
- **`stopOnError`.** The run stops with reason `error` after the first result that has an `error` or a failed test.
- **Ending a run.** Stop, workspace close or switch, and `cancelAllSends` all abort the run. Its `finished` event
  carries `stopped`, and no event is emitted after `finished`.
- **Masking.** URLs in results are masked the same way the pipeline masks log lines.
- **Starting.** `start` validates the options. `invalid_run_options: <field>` covers iterations or delay out of range,
  an empty `requestPaths`, and a path outside `path`.

- [ ] **Step 1: Write failing tests**, with fake deps and fake timers where useful:
  - The order across iterations and the data row cycling.
  - The `setNextRequest` jump, `null` and a missing name.
  - The loop guard.
  - The delay happens between requests only.
  - `stopOnError`.
  - Stopping during a send and during a delay: Review Focus 1.
  - A load error continues the run: Review Focus 5.
  - Workspace close stops the run: Review Focus 4.
  - `runner_busy`.
  - With `keepVariables: false`, the env store is never written, while a later request in the run sees the earlier
    `pm.environment.set`. This uses the real pipeline with the in-process engine, as `scriptPipeline.test.ts` does.
  - `api.test.ts`: `runner.start` drives real sends against a local test server and emits the events in order.
    `pickDataFile` and `saveReport` use injected dialog deps, as `transfer` does.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Add the e2e hooks `ASTRAL_E2E_DATA_FILE` (the path `pickDataFile` returns) and the
  existing `ASTRAL_E2E_EXPORT_DIR` for `saveReport`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(runner): run collections and folders with iterations, delay and data`

---

### Task 3: Runner tab

**Files:**
- Create: `src/renderer/src/components/runner/RunnerTab.tsx`, `RunnerConfig.tsx`, `RunnerResults.tsx`,
  `src/renderer/src/lib/runReport.ts`
- Modify: `src/renderer/src/state/store.ts`, `lib/tabs.ts`, `TreeView.tsx`, `ContainerEditor.tsx`,
  `RequestTabs.tsx`, `styles.css`, `tests/e2e/smoke.spec.ts`
- Test: `tests/renderer/runner.test.tsx`, `tests/renderer/runReport.test.ts`

**Interfaces:**
```ts
// lib/runReport.ts
export interface RunReport {
  collection: string; folder?: string; environment: string | null
  startedAt: string; durationMs: number; reason: StopReason
  iterations: number; delayMs: number; dataFile: string | null
  totals: { requests: number; failedRequests: number; tests: { passed: number; failed: number; skipped: number }; avgTimeMs: number }
  results: RunResult[]
}
export function buildReport(meta: ..., results: RunResult[], finished: { reason: StopReason; durationMs: number }): RunReport
export function reportFileName(name: string, startedAt: string): string   // `<name>-run-<yyyy-mm-dd-hhmmss>.json`, illegal chars → _
```

**UI:**

- **Opening the Runner tab.**
  - The collection and folder menus get `Run`, and the ContainerEditor header gets a `Run` button with a lucide
    `Play` icon.
  - Either one opens or activates the tab, with tab id `runner:<path>`, a lucide `ListChecks` icon and the title
    `Runner · <name>`.
- **Configuration**, shown before a run and after `New run`. It has two columns:
  - **Run order.** On the left, the requests in run order, each with a checkbox, method badge and name.
    `Select all` and `Deselect all` sit above the list. The Run button is disabled when nothing is selected.
  - **Settings.** On the right:
    - Iterations: a number input, 1 to 10 000.
    - Delay (ms): a number input, 0 to 600 000.
    - Data: a `Select file` button. Once a file is chosen it shows its name, `N rows`, a preview table of the first 5
      rows, and a remove button. A parse error appears inline in `--content-error`.
    - `Keep variable values` and `Stop run if a test fails or a request errors`, as checkboxes.
    - A primary `Run <name>` button.

    The environment is the active one, shown read-only as `Environment: <name | No environment>`.
- **Starting.** `Run` calls `flushAll()`, then `runner.start`.
- **Results.**
  - **Summary bar:** `Iterations n`, `Duration`, `Avg. response time`, and passed/failed test counts in success and
    error colours. While a run is going, it also shows a live progress count `k / total`.
  - **Buttons:** `Stop` while running; `Run again` (same options), `New run` and `Export results` when finished.
  - **Filter:** `All`, `Passed`, `Failed`.
  - **Groups.** Results are grouped under `Iteration n` headers. Each request row shows the method badge, name,
    masked URL, status (coloured like the response status), time and size. Under it are its test rows (PASS / FAIL /
    SKIP badges and the error), its failures, and its error.
  - **End state.** When the run ends it shows the reason, for example `Stopped`, `Completed` or
    `Next request "X" not found`.
- **Keeping state.** Results stay in the store per tab until the tab is closed. Closing a running tab stops the run.
- **Export.** `Export results` sends `buildReport` through `runner.saveReport` with `reportFileName`.

- [ ] **Step 1: Write failing tests:**
  - Opening from the menu and from the ContainerEditor.
  - The default selection includes all requests, in tree order.
  - Deselecting one and running sends the right `requestPaths`.
  - The iteration and delay bounds.
  - Choosing data shows the preview, and a pick error shows inline.
  - `flushAll` runs before `start`.
  - Streamed events render grouped rows and the summary.
  - Filters.
  - Stop calls `runner.stop`.
  - Closing a running tab stops it.
  - Export calls `saveReport` with the report JSON and file name.
  - `runReport.test.ts`: the totals, the average and the file name.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Extend the e2e test** (written, not run):
  - Add a second request to Demo.
  - Open Runner, choose the `ASTRAL_E2E_DATA_FILE` CSV with 2 rows, and set 2 iterations.
  - Run, and assert 4 request rows with all tests passed.
  - Export into `ASTRAL_E2E_EXPORT_DIR`, and assert the file parses with `totals.requests === 4`.
  - Take shots `g1-runner-config` and `g2-runner-results`.
- [ ] **Step 5: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `feat(ui): run collections from a Runner tab and export the results`
