# Load Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load-test a request or a folder with virtual users, a duration and a ramp-up. Show live and final metrics:
requests per second, p50/p95/p99 latency, error rate, a status code breakdown and an error breakdown. Export the
report as JSON.

**Architecture:**

- **Resolution.** The main process resolves the request (or the folder's requests) once, with the active
  environment, collection variables, globals and inherited auth. Scripts are not run.
- **Load generation.** The resolved requests go to N `worker_threads` workers. Each worker drives its share of
  virtual users with its own undici `Agent` and its own keep-alive pool.
- **Metrics.** Workers record into mergeable log-linear histograms and per-second counters, and post a snapshot
  every 1 s. Main merges the snapshots and streams `LoadEvent`s to the renderer.
- **UI.** The renderer shows a Load test tab: configuration, then live stat tiles and two hand-rolled SVG charts.

**Tech Stack:** Electron 44, Node `worker_threads`, `undici` 8.12.3 (already a dependency), TypeScript strict,
React 19, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-astral-maria-design.md`. The relevant parts:

- Scope: "Load testing of a request or folder: virtual users, duration, ramp-up; live and final metrics (requests/s,
  p50/p95/p99 latency, error rate, status code breakdown)".
- Decision 7: "runs in worker threads in the app process, using `undici`; scripts are not executed per virtual user
  in v1 (the request is sent with environment variables resolved once)".

**UI binding:** `docs/superpowers/specs/2026-10-21-postman-measurements.md`. **Charts follow the dataviz method.**
The validated palette below was checked with the dataviz validator against the app's surfaces.

## Global Constraints

- **Limits.**
  - Virtual users: 1 to 1000.
  - Duration: 1 s to 3600 s.
  - Ramp-up: 0 to the duration.
  - Think time (pause after each request, per VU): 0 to 60 000 ms.
  - Request timeout: 1 to 120 s, default 30 s.
  - Max response body read: the body is drained and discarded, and only its byte count is kept.
  - Out-of-range values give `invalid_load_options: <field>`.
- **Workers.** `min(4, os.availableParallelism() - 1, VUs)` workers, at least 1. VUs are split evenly between them.
  Each worker runs one undici `Agent` with `connections` equal to its VU count, plus keep-alive.
- **Ramp-up.** Linear. VU `k` (0-based, global) starts at `rampUp * k / VUs`. With ramp-up 0, all VUs start at once.
  During ramp-down, at the end of the duration, no new requests start, and in-flight ones may finish within 2 s.
  Anything still running after that is aborted and counted as `aborted`. Aborted requests are left out of the
  latency stats.
- **Folder mode.** Each VU walks the folder's requests in tree order, round-robin, starting at index
  `k % requests.length` so that the load is spread.
- **Latency.** From just before `dispatch` to the end of the body, measured with `performance.now()`.
- **The histogram.** Log-linear buckets from 0.1 ms to 120 000 ms, with at most 1 % relative error, mergeable by
  summing counts. Percentiles are read from the bucket upper bound, clamped to the observed max.
- **Errors.** A response of any status counts as `ok` for transport. Status codes 4xx and 5xx count as errors in the
  error rate. Transport failures are counted under their code (`ECONNREFUSED`, `timeout`, `tls` and so on) and count
  as errors too. Error rate = (4xx + 5xx + transport failures) / completed.
- **Target warning.** The first time a host that is not loopback or a private address is targeted, the UI asks for
  a one-time confirmation per host. The text is: `Only load-test systems you own or have permission to test.` The
  confirmed hosts are kept in prefs.
- **Masking.** Secrets of 4 or more characters (active environment and globals) are masked with `••••` in every URL
  shown or exported, as the runner does.
- **Commits** are conventional. They end with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01W7UnCdyUfoFmAZKAA878zM
  ```

  Check that `git config user.email` is `stas.lisavoy@icloud.com`. Never change the identity, and never push.
- **Implementers** run only `npm test` and `npm run typecheck`. They never run build, e2e, dev or Electron.
  Load tests target local test servers only.
- **Branch:** `feat/load-testing`, cut from `main`.

## Review Focus

1. **Stop mid-test** aborts every worker within 2 s. The partial report is kept, its reason is `stopped`, and
   nothing is sent after the `finished` event. *Test in Task 2.*
2. **An unreachable target** (connection refused) does not spin in a hot loop. A VU whose request failed at
   transport level waits `max(thinkTime, 50 ms)` before the next attempt, and the error breakdown shows
   `ECONNREFUSED`. *Test in Task 2.*
3. **Percentile accuracy.** p50/p95/p99 from merged histograms are within 1 % of the exact values computed from a
   known sample of 100 000 latencies. *Test in Task 1.*
4. **Closing or switching the workspace, or quitting the app,** stops a running test, and the workers exit.
   *Test in Task 2. The quit path calls the same stop.*
5. **A request with a body (POST raw JSON, urlencoded, form-data)** sends the same bytes and headers as Send would.
   The load path builds its dispatch options with the same helper as `sendRequest`, factored out. *Test in Task 2:
   the test server records one request from each path and the test compares them.*

---

### Task 1: Metrics core

**Files:**
- Create: `src/main/load/histogram.ts`, `src/main/load/metrics.ts`
- Test: `tests/main/loadHistogram.test.ts`, `tests/main/loadMetrics.test.ts`

**Interfaces:**
```ts
// histogram.ts — plain arrays so snapshots cross postMessage cheaply
export class Histogram {
  record(ms: number): void
  merge(other: HistogramData): void
  percentile(p: number): number      // 0..100; 0 when empty
  get count(): number; get min(): number; get max(): number; get mean(): number
  toData(): HistogramData
  static from(data: HistogramData): Histogram
}
export interface HistogramData { counts: number[]; count: number; sum: number; min: number; max: number }
// metrics.ts
export interface SecondBucket { t: number; completed: number; errors: number; latency: HistogramData; activeVus: number }   // t = whole seconds since start
export interface MetricsSnapshot {
  total: { completed: number; errors: number; aborted: number; bytes: number; latency: HistogramData }
  status: Record<string, number>     // "200", "404", …
  errors: Record<string, number>     // "ECONNREFUSED", "timeout", "4xx", "5xx", …
  seconds: SecondBucket[]            // buckets closed since the previous snapshot
}
export class Metrics {
  constructor(startedAt: number)
  recordResponse(status: number, ms: number, bytes: number, at: number): void
  recordFailure(code: string, at: number): void
  recordAborted(): void
  setActiveVus(n: number, at: number): void
  /** Returns and clears what accumulated since the last call; the totals keep growing. */
  drain(now: number): MetricsSnapshot
}
export function mergeSnapshots(into: MetricsSnapshot, from: MetricsSnapshot): MetricsSnapshot   // same-t seconds are merged
export function summary(s: MetricsSnapshot, durationMs: number): { rps: number; p50: number; p95: number; p99: number; mean: number; max: number; errorRate: number }
```

- [ ] **Step 1: Write failing tests.**
  - Percentiles against an exact sorted sample within 1 %, on uniform, lognormal and bimodal samples
    (Review Focus 3).
  - Merging two histograms equals recording everything into one.
  - Empty histogram behaviour.
  - Values below 0.1 ms and above 120 s are clamped into the first and last buckets.
  - `Metrics.drain`:
    - closes per-second buckets;
    - reports `activeVus` per second;
    - the error-rate rule counts 4xx, 5xx and transport failures and leaves aborted requests out;
    - status and error maps accumulate.
  - `mergeSnapshots` merges buckets that share the same `t`.
  - `summary` math.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(load): add mergeable latency histograms and per-second metrics`

---

### Task 2: Load engine, workers, IPC and events

**Files:**
- Create:
  - `src/main/load/engine.ts`: the main-side coordinator.
  - `src/main/load/worker.ts`: the worker entry.
  - `src/main/load/spawn.ts`: production wiring, the same pattern as `src/main/scripts/spawn.ts` (`?modulePath`,
    the bundle read by main and evaluated in the worker).
  - `src/main/http/dispatchOptions.ts`: the request-to-undici options builder, factored out of
    `sendRequest.ts`. `sendRequest` uses it too.
- Modify: `src/main/http/sendRequest.ts`, `src/main/api.ts`, `src/main/index.ts`, `src/shared/api.ts`,
  `src/shared/types.ts`, `src/preload/index.ts`
- Test: `tests/main/loadEngine.test.ts`, `tests/main/dispatchOptions.test.ts`, `tests/main/api.test.ts`

**Interfaces:**
```ts
// shared/types.ts
export interface LoadOptions {
  path: string                    // a request path or a folder/collection path
  environmentId: string | null
  vus: number; durationSec: number; rampUpSec: number; thinkTimeMs: number; timeoutSec: number
}
export interface LoadTick {        // one per second
  t: number; rps: number; errors: number; activeVus: number; p50: number; p95: number; p99: number
}
export interface LoadTotals {
  completed: number; errors: number; aborted: number; bytes: number
  rps: number; p50: number; p95: number; p99: number; mean: number; max: number; errorRate: number
  status: Record<string, number>; errorCodes: Record<string, number>
}
export type LoadStopReason = 'completed' | 'stopped' | 'error'
export type LoadEvent =
  | { testId: string; type: 'started'; startedAt: string; requests: { name: string; method: HttpMethod; url: string }[]; workers: number }
  | { testId: string; type: 'tick'; ticks: LoadTick[]; totals: LoadTotals }
  | { testId: string; type: 'finished'; reason: LoadStopReason; message?: string; durationMs: number; totals: LoadTotals; ticks: LoadTick[] }
// shared/api.ts — new group `load`
load: {
  start(options: LoadOptions): Promise<string>       // resolves after `started` was emitted; rejects load_busy / invalid_load_options: <field> / not_found: <path> / no_requests
  stop(testId: string): Promise<void>
  saveReport(json: string, defaultName: string): Promise<string | null>
}
// AstralEvents gains onLoadEvent(listener): () => void on LOAD_EVENT_CHANNEL = 'astral:load.event'
// dispatchOptions.ts
export function toDispatch(request: RequestItem): { origin: string; path: string; method: string; headers: Record<string, string | string[]>; body?: Buffer | string }
// engine.ts
export interface LoadDeps { spawnWorker(init: WorkerInit): WorkerLike; emit(e: LoadEvent): void; now(): number }
export function startLoad(deps: LoadDeps, resolved: { requests: RequestItem[]; displayUrls: string[] }, options: LoadOptions): { testId: string; done: Promise<void>; stop(): void }
```

**Rules:**

- **Resolution.** `api.ts` resolves every request once, exactly as Send's plain path does: inherited auth, then
  `orderedScopes` with the environment, collection (plus session overrides) and globals. It then hands them to
  `startLoad`.
- **Ticks.** Workers post a `MetricsSnapshot` every 1 s. Main merges the snapshots and emits one `tick` per second
  with that second's `LoadTick`s and the running totals.
- **One test at a time.** At most one load test per workspace (`load_busy`). It is independent of the runner.
- **Stopping.** Stop, workspace close or switch, and quit all stop the test, with reason `stopped`.
- **Worker crash.** If a worker crashes, the test ends with reason `error`, and the message names the failure.

- [ ] **Step 1: Write failing tests**, against a local `http.createServer` test server.
  - A 2 s, 5-VU test completes with `completed > 0`, a sane `rps`, and status `{"200": n}`.
  - Ramp-up: `activeVus` per tick grows roughly linearly.
  - Think time cuts the request count accordingly.
  - Folder mode spreads the load across the requests.
  - A server that returns 500 sometimes: the error rate matches.
  - A refused port gives `ECONNREFUSED` with the back-off (Review Focus 2).
  - Timeouts are counted as `timeout`.
  - Stopping mid-test (Review Focus 1).
  - `load_busy`.
  - Workspace close stops the test (Review Focus 4).
  - `toDispatch` parity with `sendRequest` for every body mode (Review Focus 5).
  - Masked display URLs.

  Use short durations: no test longer than 3 s. In vitest, start the worker with the same ts-loading bootstrap that
  `tests/main/scriptEngine.test.ts` uses.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(load): generate load from worker threads and stream live metrics`

---

### Task 3: Load test tab

**Files:**
- Create:
  - `src/renderer/src/components/load/LoadTab.tsx`, `LoadConfig.tsx`, `LoadResults.tsx`
  - `src/renderer/src/components/load/LineChart.tsx`: hand-rolled SVG with no chart library.
  - `src/renderer/src/lib/loadReport.ts`
- Modify: `state/store.ts`, `lib/tabs.ts`, `TreeView.tsx`, `RequestEditor.tsx` (the request menu or header),
  `ContainerEditor.tsx`, `RequestTabs.tsx`, `lib/prefs.ts` (confirmed hosts), `styles.css`, `tests/e2e/smoke.spec.ts`
- Test: `tests/renderer/load.test.tsx`, `tests/renderer/lineChart.test.tsx`, `tests/renderer/loadReport.test.ts`

**Opening the tab.**

- `Load test` sits in the request, folder and collection menus, and in the request header's More menu.
- The tab id is `load:<path>`, with a lucide `Gauge` icon and the title `Load · <name>`.
- Closing a running tab stops its test.

**Configuration.**

- Inputs:
  - Virtual users: number, 1 to 1000, default 10.
  - Duration (s): 1 to 3600, default 30.
  - Ramp-up (s): 0 to the duration, default 0.
  - Think time (ms): 0 to 60 000, default 0.
  - Timeout (s): 1 to 120, default 30.
- Read-only lines: the target request list (method, name, masked URL) and `Environment: <name>`.
- A note: `Scripts are not run during a load test; variables are resolved once at start.`
- Out-of-range inputs are flagged as the runner flags them.
- A primary `Start load test` button.
- Before starting, the host check from Global Constraints runs: a confirm dialog with the warning text, and
  `Start` / `Cancel`.
- The renderer flushes drafts first.

**Results.**

- **Stat tiles,** each a hero number and a small label:
  - `Requests`;
  - `Req/s` (average);
  - `p50` / `p95` / `p99` (ms);
  - `Error rate`, shown in the error colour when > 0 and paired with an alert icon;
  - `Active VUs` while running.

  While running, the header shows an elapsed / duration progress bar and a `Stop` button. When finished, it shows
  `Run again`, `New test` and `Export results`, plus the end reason.
- **Throughput chart.** Requests per second over time: one series, so no legend box. The title names it. Line
  colour is categorical slot 1.
- **Latency chart.** Three series: p50, p95 and p99. It has a legend, and each line is also labelled at its right
  end. Error rate is never on the same axis.
- **Chart marks.** 2 px lines, recessive grid and axes, and text in text tokens, never in the series colour.
- **Chart hover.** A crosshair tooltip shows the second and every series value.
- **Chart table view.** A `Table` toggle on each chart shows the per-second data as a table.
- **Breakdowns.** Two compact tables: status codes (code, count, %) and errors (code, count, %).

**Chart colours.** Validated with the dataviz validator: all checks pass. In light mode slot 3 gets a contrast WARN
(2.82:1), which the direct labels and the table view relieve. Define them as CSS tokens on `:root`, with the dark
values under both dark scopes like the existing theme tokens:

| Token | Light (surface #ffffff) | Dark (surface #282923) |
|---|---|---|
| `--chart-series-1` (rps, p50) | `#2a78d6` | `#3987e5` |
| `--chart-series-2` (p95) | `#eb6834` | `#d95926` |
| `--chart-series-3` (p99) | `#1baf7a` | `#199e70` |

**Export.** `Export results` writes `{ target, environment, options, startedAt, durationMs, reason, totals, ticks }`
through `load.saveReport` with the file name `<name>-load-<yyyy-mm-dd-hhmmss>.json` in UTC.

- [ ] **Step 1: Write failing tests:**
  - Opening from each menu.
  - Defaults and bounds.
  - The host confirmation appears for `api.example.com` and not for `127.0.0.1` or `192.168.1.5`, and is
    remembered.
  - `flushAll` runs before `load.start`.
  - Streamed ticks render tiles and chart paths.
  - Stop.
  - Closing a running tab stops the test.
  - Export.
  - `LineChart`:
    - path points map the data to the viewBox;
    - legend presence matches the series count;
    - right-end labels;
    - the crosshair tooltip;
    - the table toggle.
  - `loadReport`: the shape and the file name.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Extend the e2e test** (written, not run):
  - Load-test `Hello` against the e2e server with 5 VUs for 3 s.
  - Assert `Requests` > 0 and `Error rate` 0 %.
  - Export, and assert that the JSON has `totals.completed > 0`.
  - Take shots `i1-load-config` and `i2-load-results`.
- [ ] **Step 5: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `feat(ui): load-test requests and folders with live charts and stats`
