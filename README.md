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
| `npm run package`     | Builds an unsigned macOS app into `release/mac-arm64/`.                                                                                  |
| `npm run package:dmg` | Builds an unsigned `.dmg` into `release/`.                                                                                               |

To run the e2e steps against the packaged app, run `npm run package`, then:

```
ASTRAL_E2E_EXECUTABLE="$PWD/release/mac-arm64/Astral Maria.app/Contents/MacOS/Astral Maria" npx playwright test
```

Packaged builds are unsigned and meant for local use; macOS may ask you to allow them in System Settings.

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
