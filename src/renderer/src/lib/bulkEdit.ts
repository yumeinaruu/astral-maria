import type { KeyValue } from '../../../shared/types'

const DISABLED = '//'

/** Rows as `key:value` lines; a disabled row starts with `//`. Descriptions are not part of the text. */
export function toBulkText(rows: KeyValue[]): string {
  return rows.map((r) => `${r.enabled ? '' : DISABLED}${r.key}:${r.value}`).join('\n')
}

/**
 * Parses `key:value` lines (the first colon splits; `//` disables a line; blank lines are skipped). A row keeps the
 * description of the previous row at the same position with the same key, so a round trip loses nothing.
 */
export function fromBulkText(text: string, previous: KeyValue[]): KeyValue[] {
  const rows: KeyValue[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '') continue
    const enabled = !line.startsWith(DISABLED)
    if (!enabled) line = line.slice(DISABLED.length).trimStart()
    const colon = line.indexOf(':')
    const key = (colon < 0 ? line : line.slice(0, colon)).trim()
    const value = colon < 0 ? '' : line.slice(colon + 1).trim()
    const before = previous[rows.length]
    const row: KeyValue = { key, value, enabled }
    if (before?.key === key && before.description !== undefined) row.description = before.description
    rows.push(row)
  }
  return rows
}
