import { describe, expect, it } from 'vitest'
import { appMenuTemplate, windowBackground } from '../../src/main/menu'
import type { MenuItemConstructorOptions } from 'electron'

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu) : [])])
}

describe('application menu', () => {
  it.each(['darwin', 'win32', 'linux'] as const)(
    'has no close accelerator on %s, but keeps quit and edit',
    (platform) => {
      const items = flatten(appMenuTemplate(platform, 'Astral Maria'))
      const roles = items.map((i) => i.role).filter(Boolean)
      expect(roles).not.toContain('close')
      expect(roles).not.toContain('windowMenu')
      expect(roles).not.toContain('fileMenu')
      expect(items.some((i) => typeof i.accelerator === 'string' && /\+W$/i.test(i.accelerator))).toBe(false)
      expect(roles).toEqual(expect.arrayContaining(['quit', 'copy', 'paste', 'undo', 'selectAll']))
    },
  )
})

describe('window background', () => {
  it('matches the --bg token of each scheme', () => {
    expect(windowBackground(true)).toBe('#282924')
    expect(windowBackground(false)).toBe('#ffffff')
  })
})
