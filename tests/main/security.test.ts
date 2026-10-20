import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { devServerUrlFor, isAllowedRendererUrl, isE2eAllowed, isPermissionAllowed } from '../../src/main/security'

describe('isAllowedRendererUrl', () => {
  const rendererRoot = '/Applications/Astral Maria.app/Contents/Resources/app.asar/out/renderer'
  const root = { rendererRoot }
  const dev = { rendererRoot, devServerUrl: 'http://localhost:5173' }

  it('allows file URLs inside the renderer directory only', () => {
    expect(isAllowedRendererUrl(pathToFileURL(`${rendererRoot}/index.html`).href, root)).toBe(true)
    expect(isAllowedRendererUrl(pathToFileURL(`${rendererRoot}/assets/index-1.js`).href, root)).toBe(true)
    expect(isAllowedRendererUrl(`${pathToFileURL(`${rendererRoot}/index.html`).href}#x`, root)).toBe(true)
  })

  it('denies other file URLs, including look-alike and escaping paths', () => {
    expect(isAllowedRendererUrl('file:///etc/passwd', root)).toBe(false)
    expect(isAllowedRendererUrl('file:///app/index.html', root)).toBe(false)
    expect(isAllowedRendererUrl(pathToFileURL(`${rendererRoot}-evil/index.html`).href, root)).toBe(false)
    expect(isAllowedRendererUrl(`file://${rendererRoot.replace(/ /g, '%20')}/../../../../secret`, root)).toBe(false)
    expect(isAllowedRendererUrl(pathToFileURL(path.dirname(rendererRoot)).href, root)).toBe(false)
    expect(isAllowedRendererUrl('file://remote-host/share/index.html', root)).toBe(false)
  })

  it('allows devtools URLs', () => {
    expect(isAllowedRendererUrl('devtools://devtools/x', root)).toBe(true)
  })

  it('denies remote URLs', () => {
    expect(isAllowedRendererUrl('https://example.com', root)).toBe(false)
    expect(isAllowedRendererUrl('not a url', root)).toBe(false)
  })

  it('denies localhost when no dev server is given', () => {
    expect(isAllowedRendererUrl('http://localhost:9999', root)).toBe(false)
  })

  it('allows the dev server origin', () => {
    expect(isAllowedRendererUrl('http://localhost:5173/x', dev)).toBe(true)
  })

  it('denies other ports than the dev server', () => {
    expect(isAllowedRendererUrl('http://localhost:5174/x', dev)).toBe(false)
  })

  it('allows the dev server websocket for hot reload', () => {
    expect(isAllowedRendererUrl('ws://localhost:5173/', dev)).toBe(true)
  })
})

describe('isPermissionAllowed', () => {
  it('allows only writing to the clipboard (Copy body)', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write')).toBe(true)
  })

  it('denies every other permission request and check', () => {
    for (const p of [
      'media',
      'geolocation',
      'notifications',
      'midi',
      'openExternal',
      'fullscreen',
      'clipboard-read',
      'unknown'
    ]) {
      expect(isPermissionAllowed(p), p).toBe(false)
    }
  })
})

describe('devServerUrlFor', () => {
  it('honours ELECTRON_RENDERER_URL only in an unpackaged (development) run', () => {
    expect(devServerUrlFor({ isPackaged: false, rendererUrl: 'http://localhost:5173' })).toBe('http://localhost:5173')
    expect(devServerUrlFor({ isPackaged: true, rendererUrl: 'https://evil.example' })).toBeUndefined()
    expect(devServerUrlFor({ isPackaged: false, rendererUrl: undefined })).toBeUndefined()
    expect(devServerUrlFor({ isPackaged: false, rendererUrl: '' })).toBeUndefined()
  })
})

describe('isE2eAllowed', () => {
  const tmp = '/var/folders/xy/T'
  const ok = {
    isPackaged: true,
    nodeEnv: 'test',
    workspace: '/var/folders/xy/T/astral-e2e-1/workspace',
    userDataArgPresent: true,
    tmpdir: tmp
  }

  it('allows the hooks for a test run with a temp workspace and an explicit user-data dir', () => {
    expect(isE2eAllowed(ok)).toBe(true)
    expect(isE2eAllowed({ ...ok, isPackaged: false })).toBe(true)
  })

  it('ignores them unless NODE_ENV is test', () => {
    expect(isE2eAllowed({ ...ok, nodeEnv: undefined })).toBe(false)
    expect(isE2eAllowed({ ...ok, nodeEnv: 'production' })).toBe(false)
  })

  it('ignores them without a workspace inside the temp directory', () => {
    expect(isE2eAllowed({ ...ok, workspace: undefined })).toBe(false)
    expect(isE2eAllowed({ ...ok, workspace: '' })).toBe(false)
    expect(isE2eAllowed({ ...ok, workspace: '/Users/me/projects/api' })).toBe(false)
    expect(isE2eAllowed({ ...ok, workspace: tmp })).toBe(false)
    expect(isE2eAllowed({ ...ok, workspace: '/var/folders/xy/T/../../../Users/me' })).toBe(false)
    expect(isE2eAllowed({ ...ok, workspace: '/var/folders/xy/Tother/w' })).toBe(false)
    expect(isE2eAllowed({ ...ok, workspace: 'relative/w' })).toBe(false)
  })

  it('ignores them without an explicit --user-data-dir', () => {
    expect(isE2eAllowed({ ...ok, userDataArgPresent: false })).toBe(false)
  })
})
