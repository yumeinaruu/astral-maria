import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron'
import { join } from 'node:path'
import { API_METHODS, channelName } from '../shared/api'
import { createApi } from './api'
import { createSecretCipher } from './secretCipher'
import { isAllowedRendererUrl } from './security'

// E2E only: use Chromium's mock keychain so tests never prompt for, or touch, the real macOS Keychain.
// Must run before the app is ready.
if (process.env.NODE_ENV === 'test' && process.env.ASTRAL_E2E_WORKSPACE) {
  app.commandLine.appendSwitch('use-mock-keychain')
}

const devServerUrl = process.env['ELECTRON_RENDERER_URL']

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
