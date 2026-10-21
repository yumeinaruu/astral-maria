# Postman Import and Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import Postman Collection v2.1/v2.0, environment and globals files into the native workspace layout, and
export collections as Collection v2.1 and environments in Postman's environment format.

**Architecture:** Pure converters in `src/main/postman/` turn parsed JSON into native shapes (and back) with no I/O.
The stores get one atomic write path per import, and a new `transfer` IPC group drives native file dialogs. The
renderer adds an Import dialog (drop, choose files, paste) and Export items in the collection and environment menus.

**Tech Stack:** Electron 44, TypeScript strict, React 19, zustand, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-astral-maria-design.md` (Scope, decision 2 and 3, Delivery order item 2).

**Deviation from spec decision 3:** the spec suggests the `postman-collection` package for parsing. This plan writes
its own converter. The package pulls in a large dependency tree (lodash, faker, mime-format, sanitize-html,
etc.). It models the SDK's runtime objects rather than the plain file, so it would add a third shape between the
file and our model. We only need a lossless mapping of the documented JSON fields we support. The converter is
covered by fixture tests in both directions.

## Global Constraints

- No code, text, icons or sample files copied from Postman. Test fixtures are written by hand for this repo.
- Exported collection `info.schema` is exactly `https://schema.getpostman.com/json/collection/v2.1.0/collection.json`.
- Secrets are exported with an empty value. Nothing secret reaches a committed file on import.
- Imported items always get fresh ids (`randomUUID`). Names are kept as they are, and only slugs are made unique.
- No new npm dependencies.
- Do not run `npm run build`, `npm run e2e` or anything that packages the app; the user runs those. Run `npm test`
  and `npm run typecheck` only.
- Commits are conventional (`feat(import): …`) and end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Check that `git config user.email` is
  `stas.lisavoy@icloud.com` before the first commit. Never change the git identity. Never push.
- Work on branch `feat/postman-transfer`, created from `feat/postman-ui`.

## Review Focus

1. Two files dropped together that contain collections with the same name both import into distinct directories,
   and both keep the original name. *Test in Task 4.*
2. Item names with `/`, `..`, `CON`, emoji or an empty string become safe slugs, and the shown name is unchanged
   (empty becomes `New Request` / `New Folder`). *Test in Task 4.*
3. If writing fails mid-import, no half-written collection shows in the sidebar: the temp directory is hidden and
   removed. *Test in Task 4.*
4. Odd input is rejected with a clear message and nothing is written:
   - a leading BOM is stripped and the file imports
   - text over 50 MB, non-JSON, a JSON array, `null`, a v1 collection and a Postman data dump are rejected
   *Test in Task 2 (parsing) and Task 4 (size).*
5. Exporting a collection while a request has unsaved edits exports those edits. The store flushes drafts first.
   *Test in Task 5.*

---

### Task 1: Persist scripts and the per-variable `local` flag

**Files:**
- Modify: `src/shared/types.ts`, `src/main/storage/collectionStore.ts`, `src/main/storage/environmentStore.ts`,
  `src/renderer/src/lib/environments.ts`
- Test: `tests/main/collectionStore.test.ts`, `tests/main/environmentStore.test.ts`, `tests/renderer/environments.test.tsx`

**Interfaces:**
- Produces, in `src/shared/types.ts`:
  ```ts
  /** Script source as written by the user; run by the scripting plan, only stored for now. */
  export interface Scripts { preRequest: string; postResponse: string }
  // RequestItem.scripts?: Scripts
  // FolderNode.scripts?: Scripts
  // CollectionTree.scripts?: Scripts
  // EnvVar.local?: boolean   — the editor shows and writes the current value; per machine, kept in `.local/`
  ```

- [ ] **Step 1: Write failing store tests**

  - `collectionStore`: a request file with `scripts: { preRequest: 'a', postResponse: 'b' }` lists with the same
    `scripts`. A `folder.json` or `collection.json` with `scripts` exposes it on the `FolderNode` / `CollectionTree`.
    `scripts` that is not an object of two strings is a load error for that file. Renaming a folder or collection
    and reordering its children keep `scripts` in the meta file.
  - `environmentStore`: saving `{ key: 'h', value: 'x', currentValue: 'x', secret: false, enabled: true, local: true }`
    writes `.local/environments/<slug>.json` as `{ values: { h: 'x' }, local: ['h'] }`, and `list()` returns the
    variable with `local: true`. With `local: true` and no `currentValue`, the `.local` file is still written, as
    `{ values: {}, local: ['h'] }`. `local` on a secret is ignored, because secrets are always local. A `.local` file
    whose `local` is not an array of strings is a load error. The committed file never contains `local`.

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/main/collectionStore.test.ts tests/main/environmentStore.test.ts`

- [ ] **Step 3: Implement**

  - Validate optional `scripts` in `checkRequest` and `checkMeta`, and pass meta `scripts` through in `list()` and
    `loadChildren()`.
  - In `EnvironmentStore`, `checkLocal` returns `{ values, local }`. `withLocalValues` sets `local: true` on
    listed non-secret keys. `save` writes `local` for vars with `local === true && !secret`, and writes the file when
    `values` or `local` is non-empty.

- [ ] **Step 4: Write failing renderer test**

  In `environments.test.tsx`, switch a row to Local without changing its value (so current equals initial), save,
  and reload from a store mock that echoes what was saved. The row still shows as Local. `toEnvironment` emits
  `local: true` only for local non-secret rows. `fingerprint` changes when `local` flips.

- [ ] **Step 5: Implement** — `toRow`: `local: v.local ?? (v.currentValue !== undefined && v.currentValue !== v.value)`;
  `toEnvironment`: set `local: true` when `r.local && !r.secret`; `fingerprint` keeps `local`.

- [ ] **Step 6: Run** `npm test && npm run typecheck`. Expected: all pass.

- [ ] **Step 7: Commit** — `feat(storage): keep request and folder scripts and remember local variables`

---

### Task 2: Postman → native converter

**Files:**
- Create: `src/main/postman/importer.ts`, `src/main/postman/url.ts`
- Create fixtures (hand-written): `tests/fixtures/postman/full.v21.postman_collection.json`,
  `legacy.v20.postman_collection.json`, `dev.postman_environment.json`, `workspace.postman_globals.json`,
  `v1.postman_collection.json`, `dump.json`
- Test: `tests/main/postmanImport.test.ts`, `tests/main/postmanUrl.test.ts`

**Interfaces:**
- Consumes: types from Task 1.
- Produces:
  ```ts
  // importer.ts
  export type ImportedNode =
    | { kind: 'folder'; name: string; scripts?: Scripts; children: ImportedNode[] }
    | { kind: 'request'; request: Omit<RequestItem, 'id'> }
  export interface ImportedCollection { name: string; variables: KeyValue[]; auth: Auth; scripts?: Scripts; children: ImportedNode[] }
  export interface ImportedEnvironment { name: string; scope: 'environment' | 'globals'; variables: EnvVar[] }
  export type Parsed =
    | { kind: 'collection'; collection: ImportedCollection; warnings: string[] }
    | { kind: 'environment'; environment: ImportedEnvironment; warnings: string[] }
  /** Throws an Error whose message is shown to the user as is. */
  export function parsePostman(text: string): Parsed
  // url.ts
  export function splitQuery(raw: string): { url: string; params: KeyValue[] }
  export function toPostmanUrl(url: string, params: KeyValue[]): PostmanUrl   // used by Task 3
  export interface PostmanUrl { raw: string; protocol?: string; host?: string[]; port?: string; path?: string[]; query?: { key: string; value: string; disabled?: boolean; description?: string }[] }
  ```

**Mapping (the decisions; the tests pin each row):**

| Postman | Native |
|---|---|
| Schema detection | `info.schema` containing `v2.1` or `v2.0`, or `info` plus an `item` array, means a collection. A `values` array plus a `name` string means an environment; `_postman_variable_scope: 'globals'` sets scope `globals`. |
| Leading `﻿` | stripped |
| Non-JSON | rejected: `Not valid JSON: <parser message>` |
| JSON that is not an object | rejected: `Not a Postman collection or environment file` |
| v1 (`requests` array, no `info`) | rejected: `Postman Collection v1 is not supported. Export it from Postman as Collection v2.1 and import that file.` |
| Data dump (`version` plus a `collections` array) | rejected: `This is a Postman data dump. Export the collections and environments one by one and import those files.` |
| Anything else | rejected: `Not a Postman collection or environment file` |
| Item with an `item` array | folder (even if empty); otherwise a request; missing name → `New Folder` / `New Request` |
| `request` given as a string | GET to that URL |
| `method` | upper-cased; outside `HttpMethod` → `GET`, warning `"<name>": method <M> is not supported, imported as GET` |
| `url` as a string or object | take `raw` (or rebuild it from protocol/host/port/path); `splitQuery`. When the object has a `query` array, params come from it (keeping `disabled`) rather than from `raw`. Values stay as written, not decoded. |
| `url.variable` non-empty | URL kept, warning `"<name>": path variables are not supported; :name segments are left in the URL` |
| `header[]` | `{ key, value, enabled: !disabled, description }`; `description` is a string or `{ content }` |
| `body.raw` | `raw`; language from `options.raw.language` (`json`/`xml`/`html`/`text`; `javascript` and unknown → `text`) |
| `body.urlencoded` / `body.formdata` | fields. Form-data `type: 'file'` is skipped, with warning `"<name>": file field "<key>" was skipped` |
| `body.graphql` | raw `json`: `JSON.stringify({ query, variables }, null, 2)`, where `variables` is parsed if it is a JSON string. Warning `"<name>": GraphQL body imported as JSON` |
| `body.file` or other modes | `none`, warning `"<name>": <mode> body is not supported` |
| `auth` absent on a request | `inherit` |
| `auth.type` `noauth` | `none` |
| `bearer` / `basic` / `apikey` | Params come from the v2.1 `[{key, value}]` array or the v2.0 object. apikey `in` defaults to `header`; any other value except `query` also becomes `header`. |
| Other auth types | `none`, warning `"<name>": <type> auth is not supported, imported as No Auth` |
| Folder `auth` | Pushed down into every descendant request whose auth is `inherit`. A nested folder's own auth wins for its subtree. Folder `noauth` makes inheriting descendants `none`. Collection auth stays at the collection, and requests keep `inherit`. |
| `event[]` | `listen: 'prerequest'` → `scripts.preRequest`, `listen: 'test'` → `scripts.postResponse`. `exec` is an array joined with `\n`, or a string. Events with `disabled: true` are ignored. `scripts` is only set when at least one is non-empty. |
| `variable[]` (collection) | `{ key, value: String(value ?? ''), enabled: !disabled }` |
| `response[]` examples | dropped, with one warning per collection: `<N> saved example responses were not imported` |
| Descriptions of requests, folders and the collection; `protocolProfileBehavior` | dropped silently |
| Environment value, `type` `secret` | `{ key, value: '', currentValue: value || undefined, secret: true, enabled }` |
| Environment value, other `type` | `{ key, value, secret: false, enabled: enabled ?? true }` |

- [ ] **Step 1: Write the fixtures.** `full.v21` covers every row above:
  - nested folders, with folder auth at two levels
  - every body mode
  - disabled params and headers
  - both events
  - variables and examples
  - an unsupported auth and an unsupported method

  `legacy.v20` uses v2.0 auth objects and a string URL.

- [ ] **Step 2: Write failing tests**, one `it` per table row, named after it (e.g.
  `it('pushes folder auth into inheriting requests')`). `postmanUrl.test.ts` covers:
  - `splitQuery('{{base}}/a?x=1&y')` → url `{{base}}/a` and params `x=1`, `y=` (both enabled)
  - a `#fragment` stays in `url`
  - `toPostmanUrl` on `https://api.example.com:8443/v1/users` + params → protocol `https`, host
    `['api','example','com']`, port `8443`, path `['v1','users']`
  - `toPostmanUrl` on `{{base}}/users` → host `['{{base}}']`
  - `raw` contains only enabled params
  - disabled params appear in `query` with `disabled: true`

- [ ] **Step 3: Run, expect FAIL** — `npx vitest run tests/main/postmanImport.test.ts tests/main/postmanUrl.test.ts`
- [ ] **Step 4: Implement** `importer.ts` and `url.ts`. Keep them pure: no `fs`, no Electron.
- [ ] **Step 5: Run** `npm test && npm run typecheck` — PASS
- [ ] **Step 6: Commit** — `feat(import): convert Postman collections and environments to the native model`

---

### Task 3: Native → Postman exporter

**Files:**
- Create: `src/main/postman/exporter.ts`
- Test: `tests/main/postmanExport.test.ts`

**Interfaces:**
- Consumes: `toPostmanUrl` (Task 2), `CollectionTree` with `scripts` (Task 1).
- Produces:
  ```ts
  export function toPostmanCollection(tree: CollectionTree): Record<string, unknown>
  export function toPostmanEnvironment(env: Environment): Record<string, unknown>
  /** `<name>.postman_collection.json` etc., with characters illegal in file names replaced by `_`. */
  export function exportFileName(name: string, kind: 'collection' | 'environment' | 'globals'): string
  ```

**Rules:**

- **Collection fields.** `info: { _postman_id: tree.id, name, schema }`. Items are emitted in tree order. Folder
  `event` comes from `scripts`. The collection's `variable`, `auth` and `event` are emitted only when non-empty or
  not `none`.
- **Auth.** Request auth `inherit` → no `auth` key. `none` → `{ type: 'noauth' }`. Other types use the v2.1 array
  form `[{ key, value, type: 'string' }]`.
- **Bodies.** `none` → no `body`. `raw` → `{ mode: 'raw', raw, options: { raw: { language } } }`.
- **Header and field `disabled`.** Present only when the entry is disabled.
- **Events.** `exec` is the script split on `\n`. Empty scripts are not emitted.
- **Environment.** `{ id, name, values: [{ key, value: secret ? '' : value, type: secret ? 'secret' : 'default', enabled }], _postman_variable_scope }`.
  The scope is `globals` when `env.id === 'globals'`, otherwise `environment`.
- **File names.** `exportFileName('A/B: c', 'collection')` → `A_B_ c.postman_collection.json`. Globals →
  `Globals.postman_globals.json`.

- [ ] **Step 1: Write failing tests**, one per rule above. Also add the round trip: `parsePostman(JSON.stringify(toPostmanCollection(t)))`
  reproduces `t`'s names, structure, requests, variables, auth and scripts, ignoring ids. `t` is built from
  importing `full.v21`. Do the same for `dev.postman_environment.json` and globals, with secrets coming back empty.
- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/main/postmanExport.test.ts`
- [ ] **Step 3: Implement** `exporter.ts`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS
- [ ] **Step 5: Commit** — `feat(export): write collections as Collection v2.1 and environments in Postman format`

---

### Task 4: Store writes and the `transfer` IPC group

**Files:**
- Modify: `src/main/storage/collectionStore.ts`, `src/shared/api.ts`, `src/shared/types.ts`, `src/main/api.ts`,
  `src/main/index.ts`, `src/preload/index.ts` (only if the preload is not fully generated from `API_METHODS`)
- Create: `src/main/transfer.ts`
- Test: `tests/main/collectionStore.test.ts`, `tests/main/transfer.test.ts`, `tests/main/api.test.ts`

**Interfaces:**
- Consumes: `parsePostman`, `ImportedCollection`, `ImportedEnvironment` (Task 2); `toPostmanCollection`,
  `toPostmanEnvironment`, `exportFileName` (Task 3).
- Produces:
  ```ts
  // shared/types.ts
  export type ImportKind = 'collection' | 'environment' | 'globals'
  export interface ImportedItem { source: string; kind: ImportKind; name: string; warnings: string[] }
  export interface ImportReport { imported: ImportedItem[]; failed: { source: string; message: string }[] }
  // shared/api.ts — new group, also added to API_METHODS as transfer: ['importFiles', 'importText', 'exportCollection', 'exportEnvironment']
  transfer: {
    /** Open dialog for .json files (multi-select); imports each; null when cancelled. */
    importFiles(): Promise<ImportReport | null>
    /** One file's text, dropped or pasted; `source` names it in the report (file name or "Pasted text"). */
    importText(text: string, source: string): Promise<ImportReport>
    /** Save dialog, then writes Collection v2.1; resolves the written path, or null when cancelled. */
    exportCollection(collectionPath: string): Promise<string | null>
    exportEnvironment(id: string): Promise<string | null>
  }
  // collectionStore.ts
  importCollection(c: ImportedCollection): Promise<CollectionTree>
  // transfer.ts
  export const MAX_IMPORT_BYTES = 50 * 1024 * 1024
  export function mergeGlobals(existing: EnvVar[], imported: EnvVar[]): EnvVar[]
  // ApiDeps gains:
  pickImportFiles: () => Promise<string[]>
  pickExportPath: (defaultName: string) => Promise<string | null>
  ```

- [ ] **Step 1: Write failing tests**
  - **`importCollection`, writing.**
    - It writes `collections/.import-<uuid>/` and then renames it to `uniqueSlug(slugify(name))`.
    - Fresh ids everywhere. Folder and collection `scripts`, `order`, variables and auth are all written.
  - **`importCollection`, names.**
    - Two imports of the same name → two directories, the same `name`.
    - Names `a/b`, `..`, `CON`, `🙂`, and `''` (shown as `New Request`) give safe slugs.
  - **`importCollection`, failure.** With a failing write (stub `writeJsonAtomic` or make the temp dir read-only),
    the call rejects, no `.import-*` directory remains, and `list()` shows nothing new.
  - **`importText`, collections and environments.**
    - A collection → one `ImportedItem` of kind `collection`, and it is in `collections.list()`.
    - An environment → a new environment with a fresh id. Secrets go to `.local` only; the committed file has an
      empty value.
  - **`importText`, globals.**
    - Globals → `mergeGlobals`. Imported keys replace `value`, `secret`, `enabled` and `currentValue` of
      existing keys. New keys are appended, and other keys are kept.
    - The `globals` environment is created when missing.
  - **`importText`, rejection.** Text over `MAX_IMPORT_BYTES` (UTF-8 bytes), or text that `parsePostman` rejects,
    ends up in `failed` with the message, and nothing is written.
  - **`importFiles`.**
    - `pickImportFiles` returns two paths → both are read, in order. A file over the limit is rejected after
      `stat`, without being read.
    - An empty list → `null`.
  - **`exportCollection`.**
    - It writes `JSON.stringify(doc, null, 2)` to the path from `pickExportPath(exportFileName(...))` and resolves
      that path. A `null` path → `null`, and nothing is written.
    - An unknown collection path rejects `collection_not_found`.
  - **`exportEnvironment`.** Same as `exportCollection`. Unknown id → `environment_not_found`.
- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/main`
- [ ] **Step 3: Implement**
  - Put the import and export orchestration in `transfer.ts`, and call it from `createApi` through `tracked`.
  - `index.ts` wires the native dialogs:
    - `showOpenDialog` with `openFile`, `multiSelections` and a JSON filter
    - `showSaveDialog` with `defaultPath` set to the name
  - Add e2e hooks next to the `pickDirectory` hook, behind the same `isE2eAllowed` gate:
    - `ASTRAL_E2E_IMPORT_FILES`: paths joined by `path.delimiter`
    - `ASTRAL_E2E_EXPORT_DIR`: `pickExportPath` returns `join(dir, defaultName)`
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS
- [ ] **Step 5: Commit** — `feat(transfer): import and export Postman files through native dialogs`

---

### Task 5: Import dialog and Export menu items

**Files:**
- Create: `src/renderer/src/components/ImportDialog.tsx`
- Modify: `src/renderer/src/state/store.ts`, `src/renderer/src/components/Sidebar.tsx`, `TreeView.tsx`,
  `EnvironmentList.tsx`, `App.tsx` (shortcut), `src/renderer/src/styles.css`, `tests/e2e/smoke.spec.ts`
- Test: `tests/renderer/importDialog.test.tsx`, `tests/renderer/sidebar.test.tsx`, `tests/renderer/environments.test.tsx`

**Interfaces:**
- Consumes: `window.astral.transfer` and `ImportReport` (Task 4).
- Produces, as store actions:
  ```ts
  importFiles(): Promise<ImportReport | null>
  importText(text: string, source: string): Promise<ImportReport>
  exportCollection(path: string): Promise<void>   // flushAll() first; failure → error banner
  exportEnvironment(id: string): Promise<void>    // exports the saved state
  ```
  After any import that imported something, the store reloads collections and environments.

**UI (metrics per `docs/superpowers/specs/2026-10-21-postman-measurements.md`):**

- **Entry points.**
  - An `Import` text button (24px control, 12px text) in the sidebar header, left of the `+` button.
  - `Import…` in the sidebar's More menu.
  - Cmd+O (Ctrl+O off macOS), handled at the window level like Cmd+S.
- **Dialog layout.** It uses the existing `dialog-backdrop` / `dialog` classes and is about 560px wide, titled
  `Import`. It contains:
  - A drop zone with a lucide `Upload` icon, the text `Drop Postman files here`, and a `Choose files` button
    (it calls `importFiles`). A drag over the zone highlights it with the `--input-border-focus` border.
  - A `Paste raw text` textarea (mono font, 8 rows) and an `Import` primary button, disabled while the textarea is
    empty.
- **Drop and progress.** Dropped `File`s are read with `file.text()` and sent one by one as
  `importText(text, file.name)`. While busy, the controls are disabled.
- **Results.** One line per item: `Collection "X" imported`, `Environment "X" imported` or `Globals updated`. Each
  line has a `N warnings` disclosure listing the warnings. Failed sources show in `--content-danger` with their
  message.
- **Dialog behaviour.** Esc or the `Close` button closes the dialog, focus stays inside, and focus is restored on
  close, as in `ConfirmDialog`.
- **Export.** An `Export` item on collection rows only (not folders or requests) in the TreeView menu, and on every
  environment row including Globals.

- [ ] **Step 1: Write failing tests**
  - The `Import` button and Cmd+O open the dialog.
  - Pasting the `full.v21` fixture text and pressing Import calls `transfer.importText(text, 'Pasted text')`,
    shows `Collection "…" imported` with the warning count, and triggers a reload.
  - Dropping two files calls `importText` twice, in order, with the file names.
  - A failure line shows the message.
  - Esc closes the dialog and restores focus.
  - The collection menu has `Export` and folder/request menus do not. Choosing it calls `flushAll` before
    `transfer.exportCollection(path)`. This pins Review Focus 5: a dirty draft is saved before export.
  - The environment menu, including Globals, has `Export`, which calls `transfer.exportEnvironment(id)`.
- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/renderer`
- [ ] **Step 3: Implement** the dialog, store actions, menu items, shortcut and styles.
- [ ] **Step 4: Extend `tests/e2e/smoke.spec.ts`** (written, not run):
  - Launch with `ASTRAL_E2E_IMPORT_FILES` pointing at `full.v21` and `dev.postman_environment.json`.
  - Import through `Choose files`, and assert that the collection and the environment appear.
  - Export the collection with `ASTRAL_E2E_EXPORT_DIR`, and assert that the file parses and has the v2.1 schema.
  - When `ASTRAL_E2E_SHOTS` is set, save screenshots of the dialog in its empty state and with results.
- [ ] **Step 5: Run** `npm test && npm run typecheck` — PASS
- [ ] **Step 6: Commit** — `feat(ui): import Postman files from a dialog and export from the sidebar menus`
