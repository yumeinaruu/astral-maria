# Astral Maria

Astral Maria is a local-first desktop API client for composing, sending and organising HTTP requests. Your data stays on your machine in plain files.

## Getting started

```
npm install
npm run dev
```

Requires Node >= 24.11.

## Scripts

| Command               | What it does                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`         | Starts the app with hot reload (a relaxed CSP for Vite applies only in this mode).                                                       |
| `npm test`            | Unit and component tests (vitest).                                                                                                       |
| `npm run typecheck`   | Type-checks main, preload and renderer.                                                                                                  |
| `npm run build`       | Builds `out/main`, `out/preload` and `out/renderer`.                                                                                     |
| `npm run e2e`         | Builds, then drives the real Electron app with Playwright (temporary user-data and workspace folders, mock keychain, local test server). |
| `npm run package`     | Builds an unsigned macOS app into `release/mac-arm64/`, with the production Electron fuses (see below).                                  |
| `npm run package:dmg` | Builds an unsigned `.dmg` into `release/`, with the same fuses.                                                                          |
| `npm run package:e2e` | Builds a test-only app into `release-e2e/mac-arm64/` with Electron's default fuses, for the packaged e2e run. Never ship it.             |

Production packages flip these Electron fuses (`electronFuses` in `electron-builder.yml`): `RunAsNode` off
(`ELECTRON_RUN_AS_NODE` is ignored), `EnableNodeOptionsEnvironmentVariable` off (`NODE_OPTIONS` is ignored),
`EnableNodeCliInspectArguments` off (`--inspect` is ignored), `EnableEmbeddedAsarIntegrityValidation` on and
`OnlyLoadAppFromAsar` on. A packaged build also ignores `ELECTRON_RENDERER_URL` (it always loads its own files) and
honours the e2e hooks (mock keychain, workspace folder from `ASTRAL_E2E_WORKSPACE`) only when `NODE_ENV=test`, the
workspace is inside the system temp folder and `--user-data-dir` is given.

Playwright's Electron driver attaches through the Node inspector, which the production fuses disable, so the packaged
e2e run uses the separate `package:e2e` build (`electron-builder.e2e.yml`, identical apart from the fuses):

```
npm run package:e2e
ASTRAL_E2E_EXECUTABLE="$PWD/release-e2e/mac-arm64/Astral Maria.app/Contents/MacOS/Astral Maria" npx playwright test
```

Packaged builds are unsigned (ad-hoc signed) and meant for local use; macOS may ask you to allow them in System
Settings.

## Workspace folder layout

A workspace is a plain folder, safe to put under git:

```
workspace.json                        workspace id and name
.gitignore                            contains `.local/`
collections/
  <slug>/
    collection.json                   collection settings
    <folder>/
      folder.json                     folder settings
      <slug>.request.json             one file per request
    <slug>.request.json
environments/
  <slug>.json                         variable names and shared values (secrets have an empty value)
.local/                               git-ignored, never committed
  environments/
    <slug>.json                       current values; secret values are encrypted
```

Committed: everything except `.local/`. Local only: current values and secrets (`.local/`), and the list of
recent workspaces, which lives in the app's own user-data folder. Secrets are encrypted with Electron
`safeStorage` (the macOS Keychain); when encryption is unavailable the app shows an error and does not store them.

## Privacy

Astral Maria has no AI features, no telemetry, no analytics and no update checks. The renderer is sandboxed and cannot reach the network.

The only network activity is the HTTP requests you send yourself (made by the main process) and, in later versions,
the git operations you start. Nothing else leaves your machine.
