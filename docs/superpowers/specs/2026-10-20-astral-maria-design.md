# Astral Maria: local-first API client

## Intent

A desktop API client for someone who uses Postman every day (workspaces, collections,
environments, pre-request and post-response scripts, tests, collection runs, load tests)
and does not want two things: AI features, and collections stored on someone else's server.

Everything lives on the user's disk. A workspace can be linked to a git repository and
synced with one button. Existing Postman collections and environments import cleanly, and
everything exports back to Postman format.

The working name is `astral-maria` (the project folder name). It can change.

## Goals

- Workspaces, collections with nested folders, requests, environments, globals.
- Send HTTP requests and inspect responses (body pretty/raw/preview, headers, cookies, timing, size).
- Pre-request and post-response scripts using a Postman-compatible `pm` API, so existing
  scripts keep working. Tests via `pm.test` / `pm.expect`, shown per request.
- Collection runner: run a collection or folder, with iterations, delay, and CSV/JSON data
  files; results list with per-test pass/fail; export the report as JSON.
- Load testing of a request or folder: virtual users, duration, ramp-up; live and final
  metrics (requests/s, p50/p95/p99 latency, error rate, status code breakdown).
- Import Postman Collection v2.1 (and read v2.0), Postman environment and globals files.
  Export collections as Collection v2.1 and environments in Postman's environment format.
- Local storage in plain, diff-friendly files. One workspace is one folder.
- Git sync per workspace: link a repository, then one "Sync" button.

## Non-goals (v1)

- Protocols beyond HTTP/HTTPS (no WebSocket, gRPC, GraphQL-specific UI, MQTT).
- Accounts, teams, cloud workspaces, comments, mock servers, monitors, API documentation hosting.
- Importing OpenAPI, Insomnia, Bruno or cURL. (cURL paste is a likely later add-on.)
- Mobile or web versions.

## Anti-goals (a failure even if it works)

- Any AI feature, AI dialog, or AI-adjacent prompt in the UI.
- Any telemetry, analytics, crash reporting, update ping, or other network traffic that is
  not a request the user sent or a git operation the user triggered.
- Any code, text, icons, or branding copied from Postman. The app is an independent
  implementation of the same kinds of features. Compatibility means reading and writing
  the documented Postman file formats and supporting the documented `pm` scripting API.
- Secrets pushed to git by accident.

## Constraints

- Desktop, macOS first; Windows and Linux should not be made impossible.
- The user will move the code to their own private repository later, so the repo must be
  self-contained, with a README and no dependency on this machine.
- Commits are made along the way, one per meaningful step, with the commit message format
  from the user's global code-style instructions where they apply to this stack.

## Decisions made with the user

- Postman import and export is required (collections and environments).
- Local storage plus git sync per workspace, triggered by a button.
- No AI features.
- The stack is left to the builder (see below).

## Builder's calls (not yet confirmed by the user)

1. **Stack:** Electron, TypeScript, React, Vite (electron-vite). Node 24 in the main process.
2. **On-disk format:** native, git-friendly layout, not a single Postman JSON blob:

   ```
   <workspace>/
     workspace.json            name, id, settings
     collections/<slug>/
       collection.json         info, auth, variables, collection-level scripts
       <folder>/folder.json
       <folder>/<request>.request.json    one file per request
     environments/<slug>.json              shared values ("initial values")
     .local/                               gitignored: current values, secrets, cookies, history
   ```

   One file per request keeps merges and diffs readable. Import converts Postman v2.1 into
   this layout; export converts back.
3. **Postman fidelity:** use the open-source `postman-collection` npm package (Apache-2.0)
   for parsing and validating the Collection format, and evaluate `postman-sandbox`
   (Apache-2.0) for script execution. If either is unsuitable, write a minimal
   implementation of the `pm` API subset instead. Verify licenses before adding them.
4. **Initial vs current values:** like Postman, an environment variable has a shared
   value (in git) and an optional local current value (in `.local/`, never committed).
   Variables marked secret keep their value only in `.local/`, encrypted with Electron
   `safeStorage`; the committed file contains the key with an empty value.
5. **Script sandbox:** scripts run in an isolated context (separate process or worker with
   `vm`), with a timeout, no `require` of arbitrary modules, no filesystem access.
   Supported `pm` surface for v1: `pm.environment`, `pm.globals`, `pm.collectionVariables`,
   `pm.variables`, `pm.request`, `pm.response`, `pm.test`, `pm.expect` (chai),
   `pm.sendRequest`, `pm.info`, `pm.cookies` (read), `console.*`, `postman.setNextRequest`.
   Anything unsupported fails with a clear message naming the missing API.
6. **Git sync behaviour:** uses the system `git` binary (so the user's SSH agent and
   credential helper just work; the app never stores git credentials). "Sync" does:
   commit local changes with an automatic message, fetch, merge the remote, push. If the
   merge conflicts, stop, list the conflicted files, and offer "keep mine" / "keep theirs"
   per file plus "open in editor". No force-push, ever.
7. **Load testing engine:** runs in worker threads in the app process, using `undici`;
   scripts are not executed per virtual user in v1 (the request is sent with environment
   variables resolved once), because per-user scripting changes the cost model a lot.
8. **Auth helpers in v1:** none, Bearer, Basic, API key. OAuth 2.0 later.
9. **Tests:** unit tests for the importer/exporter and git sync logic, plus end-to-end tests of the
   runner against a local test server. UI tested manually and with a few Playwright checks.

## Delivery order

This is several independent pieces; each gets its own plan and its own commits.

1. Core: workspace on disk, collections tree, request editor, send and inspect, environments.
2. Postman import and export (collections, environments, globals).
3. Scripts and tests (`pm` API, sandbox).
4. Collection runner.
5. Git sync.
6. Load testing.

Pieces 1 and 2 give a usable app first; the order of 3 to 6 can change.

## Left to the builder

Visual design (dense, keyboard-friendly, light and dark theme), component library,
editor component for bodies and scripts (Monaco or CodeMirror), state management,
packaging (electron-builder, unsigned local build is enough for now).

## Open questions for the user

- Which email should the commits carry? The global git identity here is a work address.
- Is the working name `astral-maria` fine?
