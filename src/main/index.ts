import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, session } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_METHODS, channelName, FLUSH_REQUEST_CHANNEL } from '../shared/api'
import { createApi } from './api'
import { FlushCoordinator, interceptOnce, OperationTracker } from './flushGuard'
import { appMenuTemplate, windowBackground } from './menu'
import { createSecretCipher } from './secretCipher'
import { devServerUrlFor, isAllowedRendererUrl, isE2eAllowed, isPermissionAllowed } from './security'

// No traffic of Chromium's own: no background requests (variations, component and dictionary downloads, ...).
// Must run before the app is ready.
for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-sync']) {
  app.commandLine.appendSwitch(flag)
}

/** The e2e hooks below are honoured only for a test run on a temp workspace with its own user-data folder. */
const e2eWorkspace = isE2eAllowed({
  isPackaged: app.isPackaged,
  nodeEnv: process.env.NODE_ENV,
  workspace: process.env.ASTRAL_E2E_WORKSPACE,
  userDataArgPresent: process.argv.some((a) => a === '--user-data-dir' || a.startsWith('--user-data-dir=')),
  tmpdir: tmpdir(),
})
  ? process.env.ASTRAL_E2E_WORKSPACE
  : undefined

// E2E only: use Chromium's mock keychain so tests never prompt for, or touch, the real macOS Keychain.
// Must run before the app is ready.
if (e2eWorkspace) app.commandLine.appendSwitch('use-mock-keychain')

/** A packaged build always loads its own files: a renderer URL from the environment is a development feature only. */
const devServerUrl = devServerUrlFor({ isPackaged: app.isPackaged, rendererUrl: process.env['ELECTRON_RENDERER_URL'] })
/** The built renderer; the only local files the window may load. */
const rendererRoot = join(__dirname, '../renderer')

/** How long a quit or window close waits for the renderer to report its drafts written. */
const FLUSH_TIMEOUT_MS = 3000

const operations = new OperationTracker()
const flusher = new FlushCoordinator({
  requestFlush() {
    let asked = 0
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(FLUSH_REQUEST_CHANNEL)
      asked++
    }
    return asked
  },
  idle: () => operations.idle(),
  timeoutMs: FLUSH_TIMEOUT_MS,
})
/** Set once the quit flush is done; windows closing because of the quit then close without flushing again. */
let quitFlushed = false

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Astral Maria',
    // Matches the renderer's first paint, so the window does not flash white in dark mode.
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The spellchecker downloads Hunspell dictionaries from Google on Windows and Linux.
      spellcheck: false,
    },
  })

  // Closing the window (which on macOS does not quit) first writes the drafts the renderer still holds.
  win.on(
    'close',
    interceptOnce(
      () => flusher.flush(),
      () => win.close(),
      () => quitFlushed,
    ),
  )
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('will-redirect', (event) => event.preventDefault())

  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(rendererRoot, 'index.html'))
  }
}

async function pickDirectory(): Promise<string | null> {
  // E2E hook: the native dialog cannot be driven by Playwright, so tests supply the folder via the environment.
  if (e2eWorkspace) return e2eWorkspace
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

/** One handler per API method, generated from the shared method table so main and preload cannot drift. */
function registerApi(): void {
  const api = createApi({
    cipher: createSecretCipher(safeStorage),
    pickDirectory,
    recentFile: join(app.getPath('userData'), 'recent-workspaces.json'),
    operations,
    onFlushed: () => flusher.acknowledge(),
  })
  for (const [group, methods] of Object.entries(API_METHODS)) {
    const table = api[group as keyof typeof api] as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const method of methods) {
      ipcMain.handle(channelName(group, method), (_event, ...args: unknown[]) => table[method](...args))
    }
  }
}

app.whenReady().then(() => {
  // No Close Window accelerator: Cmd/Ctrl+W reaches the renderer, which closes the active tab.
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform, app.name, { devTools: !app.isPackaged })))
  registerApi()
  const ses = session.defaultSession
  ses.setSpellCheckerEnabled(false)
  ses.setPermissionRequestHandler((_webContents, permission, callback) => callback(isPermissionAllowed(permission)))
  ses.setPermissionCheckHandler((_webContents, permission) => isPermissionAllowed(permission))
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRendererUrl(details.url, { rendererRoot, devServerUrl }) })
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quitting waits (at most FLUSH_TIMEOUT_MS for the renderer) until unsaved drafts and store writes are on disk.
app.on(
  'before-quit',
  interceptOnce(
    () => flusher.flush(),
    () => {
      quitFlushed = true
      app.quit()
    },
  ),
)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
