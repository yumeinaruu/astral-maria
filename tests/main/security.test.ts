import { describe, expect, it } from 'vitest'
import { isAllowedRendererUrl } from '../../src/main/security'

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
