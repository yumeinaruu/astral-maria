import type { EnvVar, Environment } from '../../../shared/types'

/** The globals set is the environment with this fixed id; it is listed first and can be neither renamed nor deleted. */
export const GLOBALS_ID = 'globals'
export const GLOBALS_NAME = 'Globals'

/** A variable as edited in the table; `uid` is a stable key for the row and never leaves the editor. */
export interface Row extends EnvVar {
  uid: number
  /** Explains a change the editor made to the row (e.g. a shared value moved to the current value). */
  note?: string
}

export interface Draft {
  id: string
  name: string
  rows: Row[]
  /** Not saved anywhere yet (new or duplicated). */
  isNew: boolean
}

let nextUid = 1

export function toDraft(env: Environment, isNew = false): Draft {
  return {
    id: env.id,
    name: env.name,
    rows: env.variables.map((v) => ({ ...v, uid: nextUid++ })),
    isNew,
  }
}

export function blankRow(): Row {
  return { uid: nextUid++, key: '', value: '', secret: false, enabled: true }
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

/** What gets saved: no blank trailing rows, no shared value for secrets, no empty current values. */
export function toEnvironment(draft: Draft): Environment {
  return {
    id: draft.id,
    name: draft.name.trim(),
    variables: meaningful(draft.rows).map((r) => {
      const v: EnvVar = { key: r.key, value: r.secret ? '' : r.value, secret: r.secret, enabled: r.enabled }
      if (r.currentValue) v.currentValue = r.currentValue
      return v
    }),
  }
}

/** A comparable form of an environment (also of what the store returns) for dirty and changed-on-disk checks. */
export function fingerprint(env: Environment): string {
  return JSON.stringify(
    toEnvironment({
      id: env.id,
      name: env.name,
      rows: env.variables.map((v) => ({ ...v, uid: 0 })),
      isNew: false,
    }),
  )
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
