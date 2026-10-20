/** True on macOS, where shortcuts use Cmd (⌘) instead of Ctrl. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|darwin/i.test(navigator.userAgent)

/** How a Cmd/Ctrl shortcut is written in the UI, e.g. `shortcut('K')` is ⌘K on macOS and Ctrl+K elsewhere. */
export function shortcut(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl+${key}`
}

/** The Cmd (macOS) or Ctrl (elsewhere) modifier of a key event. */
export function hasMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey
}
