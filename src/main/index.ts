import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron'
import { join } from 'node:path'
import { API_METHODS, channelName, FLUSH_REQUEST_CHANNEL } from '../shared/api'
import { createApi } from './api'
import { FlushCoordinator, interceptOnce, OperationTracker } from './flushGuard'
import { createSecretCipher } from './secretCipher'
import { isAllowedRendererUrl } from './security'

// E2E only: use Chromium's mock keychain so tests never prompt for, or touch, the real macOS Keychain.
// Must run before the app is ready.
if (process.env.NODE_ENV === 'test' && process.env.ASTRAL_E2E_WORKSPACE) {
  app.commandLine.appendSwitch('use-mock-keychain')
}

const devServerUrl = process.env['ELECTRON_RENDERER_URL']

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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
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

  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function pickDirectory(): Promise<string | null> {
  // E2E hook: the native dialog cannot be driven by Playwright, so tests supply the folder via the environment.
  if (process.env.NODE_ENV === 'test' && process.env.ASTRAL_E2E_WORKSPACE) return process.env.ASTRAL_E2E_WORKSPACE
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
  registerApi()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRendererUrl(details.url, devServerUrl) })
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
