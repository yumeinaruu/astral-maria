import { oneOf, readPref, writePref } from './prefs'

export type ThemePreference = 'system' | 'light' | 'dark'

export const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const KEY = 'theme'
const isTheme = oneOf<ThemePreference>('system', 'light', 'dark')

export function loadTheme(): ThemePreference {
  return readPref(KEY, 'system', isTheme)
}

/** System follows the OS (no attribute); Light and Dark force a palette through `data-theme` on `<html>`. */
export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

export function saveTheme(theme: ThemePreference): void {
  writePref(KEY, theme)
  applyTheme(theme)
}
