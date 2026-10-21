import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/renderer/src/styles.css', 'utf8')

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

describe('focus styles', () => {
  it('draws the focus ring inside the element in every palette', () => {
    const rings = [...css.matchAll(/--focus-ring:\s*([^;]+);/g)].map((m) => m[1])
    expect(rings.length).toBeGreaterThanOrEqual(3)
    for (const ring of rings) expect(ring).toMatch(/^inset /)
    const base = rule(':focus-visible')
    expect(base).toContain('outline-offset: -2px')
    expect(base).not.toContain('box-shadow')
  })

  it('gives text fields no ring of their own', () => {
    const fields = css.slice(css.indexOf("input:not([type='checkbox'], [type='radio']):focus-visible"))
    expect(fields.slice(0, fields.indexOf('}'))).toMatch(/textarea:focus-visible[\s\S]*outline: none/)
  })

  it('shows only the caret in a focused grid cell', () => {
    const cell = rule('.grid-input:focus-visible,\n.grid-input:focus')
    expect(cell).toContain('outline: none')
    expect(cell).toContain('box-shadow: none')
    expect(cell).not.toContain('border')
  })

  it('turns the border of composed boxes blue on focus-within, without a ring', () => {
    for (const box of ['.quick-open-box', '.filter-box', '.url-box']) {
      const focused = rule(`${box}:focus-within`)
      expect(focused, box).toContain('border-color: var(--border-focus)')
      expect(focused, box).not.toContain('box-shadow')
    }
  })

  it('never puts the old outward ring on buttons', () => {
    expect(rule('.btn:focus-visible')).not.toContain('--focus-ring')
    expect(css).not.toMatch(/0 0 0 3px/)
  })
})
