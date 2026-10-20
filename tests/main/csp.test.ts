import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCsp } from '../../src/main/csp'

const BRIEF_CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'"
const metaCsp = (html: string): string | undefined =>
  /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1]

describe('buildCsp', () => {
  it('production policy equals the brief and does not allow inline scripts', () => {
    const csp = buildCsp()
    expect(csp).toBe(BRIEF_CSP)
    const scriptish = csp.split(';').filter((d) => /^\s*(default|script)-src/.test(d))
    for (const d of scriptish) expect(d).not.toContain('unsafe-inline')
  })

  it('dev policy allows inline scripts and the dev websocket origin', () => {
    const csp = buildCsp({ wsOrigin: 'ws://localhost:5173' })
    expect(csp).toContain("script-src 'self' 'unsafe-inline'")
    expect(csp).toContain("connect-src 'self' ws://localhost:5173")
    expect(csp).toContain("base-uri 'none'; form-action 'none'; object-src 'none'")
  })

  it('source index.html carries the strict production policy', () => {
    const html = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8')
    expect(metaCsp(html)).toBe(BRIEF_CSP)
  })

  const built = resolve(__dirname, '../../out/renderer/index.html')
  it.skipIf(!existsSync(built))('built index.html keeps the strict policy', () => {
    expect(metaCsp(readFileSync(built, 'utf8'))).toBe(BRIEF_CSP)
  })
})
