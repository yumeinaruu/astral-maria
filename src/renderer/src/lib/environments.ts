import type { EnvVar, Environment } from '../../../shared/types'

/** The globals set is the environment with this fixed id; it is listed first and can be neither renamed nor deleted. */
export const GLOBALS_ID = 'globals'
export const GLOBALS_NAME = 'Globals'

/** A variable as edited in the table; `uid` is a stable key for the row and never leaves the editor. */
export interface Row extends EnvVar {
  uid: number
  /** Explains a change the editor made to the row (e.g. a shared value moved to the current value). */
  note?: string
  /**
   * The side the Value cell shows and writes: the current (local) value, or the initial (shared) one. Decided when the
   * row is loaded and changed only through the sync control, so typing never flips it. Secrets are always local.
   */
  local: boolean
  /** Created in this editor and not saved yet: switching it to local leaves its initial value empty. */
  fresh?: boolean
}

export interface Draft {
  id: string
  name: string
  rows: Row[]
}

let nextUid = 1

export function toDraft(env: Environment): Draft {
  return {
    id: env.id,
    name: env.name,
    rows: env.variables.map((v) => toRow(v)),
  }
}

/** The side a loaded variable shows: as remembered by the store, else local when its current value differs. */
function loadedLocal(v: EnvVar): boolean {
  return v.local ?? (v.currentValue !== undefined && v.currentValue !== v.value)
}

function toRow(v: EnvVar): Row {
  const row: Row = { ...v, uid: nextUid++, local: loadedLocal(v) }
  // Remembered so a rename can tell the store where the undecryptable value is kept.
  if (v.secret && v.locked) row.lockedKey = v.lockedKey ?? v.key
  return row
}

export function blankRow(): Row {
  return { uid: nextUid++, key: '', value: '', secret: false, enabled: true, local: false }
}

/** True when the Value cell shows and writes the current (local) value. */
export function isLocal(row: Row): boolean {
  return row.secret || row.local
}

/** The effective value the Value cell shows: the local one for local rows, otherwise the shared one. */
export function shownValue(row: Row): string {
  return isLocal(row) ? (row.currentValue ?? '') : row.value
}

/** The change of typing `text` into the Value cell: it goes to whichever side the row shows. */
export function writeValue(row: Row, text: string): Partial<Row> {
  if (isLocal(row)) return { currentValue: text }
  // A shared row's current value is absent or equal to the initial one; dropping it keeps the two from drifting.
  return { value: text, currentValue: undefined }
}

/**
 * The change of moving a row's shown value to the shared or the local side. Local keeps the initial value, except
 * on a variable created in this editor, whose initial value stays empty.
 */
export function switchSync(row: Row, to: 'shared' | 'local'): Partial<Row> {
  const shown = shownValue(row)
  if (to === 'shared') return { value: shown, currentValue: undefined, local: false }
  return { currentValue: shown, value: row.fresh ? '' : row.value, local: true }
}

/** A copy of a row with a free name, placed by the caller; an undecryptable value cannot be copied. */
export function duplicateRow(row: Row, taken: string[]): Row {
  const used = new Set(taken)
  let key = `${row.key}_copy`
  for (let i = 2; used.has(key); i++) key = `${row.key}_copy${i}`
  const { lockedKey: _key, locked: _locked, note: _note, ...rest } = row
  return { ...rest, key, uid: nextUid++, fresh: true }
}

function isBlank(v: EnvVar): boolean {
  return v.key === '' && v.value === '' && !v.currentValue
}

/** The rows that count: blank rows at the end are dropped. */
function meaningful<T extends EnvVar>(rows: T[]): T[] {
  let end = rows.length
  while (end > 0 && isBlank(rows[end - 1])) end--
  return rows.slice(0, end)
}

/**
 * What gets saved: no blank trailing rows, no shared value for secrets, no empty current values; `locked` only on a
 * secret without a new current value; `local` only on a local row that is not secret.
 */
export function toEnvironment(draft: Draft): Environment {
  return {
    id: draft.id,
    name: draft.name.trim(),
    variables: meaningful(draft.rows).map((r) => {
      const v: EnvVar = { key: r.key, value: r.secret ? '' : r.value, secret: r.secret, enabled: r.enabled }
      if (r.local && !r.secret) v.local = true
      if (r.currentValue) v.currentValue = r.currentValue
      // An undecryptable secret round-trips its flag so the store keeps its stored value, until a new one is typed.
      else if (r.secret && r.locked) {
        v.locked = true
        if (r.lockedKey !== undefined && r.lockedKey !== r.key) v.lockedKey = r.lockedKey
      }
      return v
    }),
  }
}

/** A comparable form of an environment (also of what the store returns) for dirty and changed-on-disk checks. */
export function fingerprint(env: Environment): string {
  const { variables } = toEnvironment({
    id: env.id,
    name: env.name,
    rows: env.variables.map((v) => ({ ...v, uid: 0, local: loadedLocal(v) })),
  })
  // Where a renamed locked value comes from is bookkeeping, not content: the store never returns it.
  return JSON.stringify({
    id: env.id,
    name: env.name.trim(),
    variables: variables.map(({ lockedKey: _from, ...v }) => v),
  })
}

/** The draft after a successful save: renamed locked values now live under their new keys, and no row is new. */
export function afterSave(draft: Draft): Draft {
  return {
    ...draft,
    rows: draft.rows.map((r) => {
      const { fresh: _fresh, ...rest } = r
      return r.lockedKey !== undefined ? { ...rest, lockedKey: r.key } : rest
    }),
  }
}

/** A copy for "Duplicate": variables are kept, secret values are not (only their keys). */
export function duplicateOf(env: Environment, name: string, id: string): Environment {
  return {
    id,
    name,
    variables: env.variables.map((v) => {
      return v.secret ? { key: v.key, value: '', secret: true, enabled: v.enabled } : { ...v }
    }),
  }
}

export function newId(): string {
  return globalThis.crypto.randomUUID()
}

/** `base`, or `base 2`, `base 3`… until it is not used (case-insensitive). */
export function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`
}

/** Problem of each row by uid; blank trailing rows are fine. */
export function rowProblems(rows: Row[]): Map<number, string> {
  const problems = new Map<number, string>()
  const counted = meaningful(rows)
  const seen = new Map<string, number>()
  for (const r of counted) seen.set(r.key, (seen.get(r.key) ?? 0) + 1)
  for (const r of counted) {
    if (r.key === '') problems.set(r.uid, 'Name is required')
    else if (/\s/.test(r.key)) problems.set(r.uid, 'Name cannot contain spaces')
    else if (/[{}]/.test(r.key)) problems.set(r.uid, 'Name cannot contain { or }')
    else if ((seen.get(r.key) ?? 0) > 1) problems.set(r.uid, 'Name is already used')
  }
  return problems
}

/** Problem of an environment name, or null. `others` are the names of all the other environments. */
export function nameProblem(name: string, others: string[]): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'Name is required'
  if (others.some((o) => o.trim().toLowerCase() === trimmed.toLowerCase())) {
    return 'Another environment already has this name'
  }
  return null
}

/** True when the draft differs from what it started from (or was last saved as). */
export function isDraftDirty(entry: { draft: Draft; baseline: string }): boolean {
  return fingerprint(toEnvironment(entry.draft)) !== entry.baseline
}

/** The names `draft` must not take: every other environment's, and Globals' until globals.json exists. */
export function otherNames(draft: Draft, environments: Environment[]): string[] {
  return [
    ...environments.filter((e) => e.id !== draft.id).map((e) => e.name),
    ...(draft.id === GLOBALS_ID || environments.some((e) => e.id === GLOBALS_ID) ? [] : [GLOBALS_NAME]),
  ]
}

/** Why `draft` cannot be saved as it is (its name or a variable has a problem), or null. */
export function draftProblem(draft: Draft, environments: Environment[]): string | null {
  const name = draft.id === GLOBALS_ID ? null : nameProblem(draft.name, otherNames(draft, environments))
  return name ?? rowProblems(draft.rows).values().next().value ?? null
}
