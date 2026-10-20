import { describe, expect, it } from 'vitest'
import { devServerUrlFor, isAllowedRendererUrl, isE2eAllowed } from '../../src/main/security'

describe('isAllowedRendererUrl', () => {
  it('allows file URLs', () => {
    expect(isAllowedRendererUrl('file:///app/index.html')).toBe(true)
  })

  it('allows devtools URLs', () => {
    expect(isAllowedRendererUrl('devtools://devtools/x')).toBe(true)
  })

  it('denies remote URLs', () => {
    expect(isAllowedRendererUrl('https://example.com')).toBe(false)
  })

  it('denies localhost when no dev server is given', () => {
    expect(isAllowedRendererUrl('http://localhost:9999')).toBe(false)
  })

  it('allows the dev server origin', () => {
    expect(isAllowedRendererUrl('http://localhost:5173/x', 'http://localhost:5173')).toBe(true)
  })

  it('denies other ports than the dev server', () => {
    expect(isAllowedRendererUrl('http://localhost:5174/x', 'http://localhost:5173')).toBe(false)
  })

  it('allows the dev server websocket for hot reload', () => {
    expect(isAllowedRendererUrl('ws://localhost:5173/', 'http://localhost:5173')).toBe(true)
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
