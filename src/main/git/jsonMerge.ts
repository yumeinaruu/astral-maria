/**
 * Three-way, field-level merge of the workspace's JSON files. Pure: no file system, no git. The caller reads the
 * base, ours and theirs versions from the index stages and writes the result.
 */

export type FileKind = 'request' | 'folder' | 'collection' | 'environment' | 'workspace' | 'other'

/**
 * Where a conflict sits in the document, as a JSON array of segments: a string names an object field, `{ key }` the
 * element of a keyed array whose `key` is that value. For example `["headers",{"key":"Authorization"}]`.
 */
type Segment = string | { key: string }

/**
 * A field both sides changed differently. `ours` / `theirs` / `base` is `undefined` where that version has no such
 * field or element (removed, or never there); choosing that side removes it.
 */
export interface FieldConflict {
  path: string
  label: string
  ours: unknown
  theirs: unknown
  base: unknown
}

export type MergeOutcome =
  | { kind: 'merged'; text: string }
  | { kind: 'conflicts'; partial: unknown; conflicts: FieldConflict[] }
  | { kind: 'unmergeable'; reason: string }

/** The kind of a workspace file, by its workspace-relative path. */
export function fileKind(relPath: string): FileKind {
  const rel = relPath.replace(/\\/g, '/')
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  if (name.endsWith('.request.json')) return 'request'
  if (name === 'folder.json') return 'folder'
  if (name === 'collection.json') return 'collection'
  if (/^environments\/[^/]+\.json$/.test(rel)) return 'environment'
  if (rel === 'workspace.json') return 'workspace'
  return 'other'
}

/** The same formatting as `writeJsonAtomic`. */
function format(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

export function mergeJson(
  kind: FileKind,
  base: string | null,
  ours: string | null,
  theirs: string | null
): MergeOutcome {
  if (kind === 'other') return { kind: 'unmergeable', reason: 'Not a workspace JSON file' }
  if (base === null || ours === null || theirs === null) {
    return { kind: 'unmergeable', reason: 'The file is missing in one of the versions' }
  }
  const parsed: unknown[] = []
  for (const [side, text] of [
    ['base', base],
    ['ours', ours],
    ['theirs', theirs]
  ] as const) {
    try {
      parsed.push(JSON.parse(text))
    } catch {
      return { kind: 'unmergeable', reason: `Invalid JSON in the ${side} version` }
    }
  }
  const conflicts: FieldConflict[] = []
  const result = merge3(kind, [], parsed[0], parsed[1], parsed[2], conflicts)
  if (conflicts.length === 0) return { kind: 'merged', text: format(result) }
  return { kind: 'conflicts', partial: result, conflicts }
}

/** Applies a choice to every conflict of `mergeJson` and returns the file text. Does not change `partial`. */
export function applyChoices(
  kind: FileKind,
  partial: unknown,
  conflicts: FieldConflict[],
  choose: (c: FieldConflict) => 'ours' | 'theirs'
): string {
  void kind
  let root = structuredClone(partial)
  for (const c of conflicts) {
    const value = choose(c) === 'ours' ? c.ours : c.theirs
    root = setAt(root, JSON.parse(c.path) as Segment[], value === undefined ? undefined : structuredClone(value))
  }
  return format(root)
}

// --- merging ---------------------------------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]))
  }
  return false
}

/** Field names as they appear in `at`: a path without the keyed-element segments, joined by `.`. */
function fieldPath(at: Segment[]): string {
  return at.filter((s): s is string => typeof s === 'string').join('.')
}

function isKeyedArray(kind: FileKind, at: Segment[]): boolean {
  const p = fieldPath(at)
  if (at.length > 0 && typeof at[at.length - 1] !== 'string') return false
  if (kind === 'request') return p === 'params' || p === 'headers' || p === 'body.fields'
  if (kind === 'collection' || kind === 'environment') return p === 'variables'
  return false
}

function isOrderArray(kind: FileKind, at: Segment[]): boolean {
  return (kind === 'folder' || kind === 'collection') && at.length === 1 && at[0] === 'order'
}

/** Merges one value; `undefined` means absent. Conflicts are pushed to `out`, and the result holds ours there. */
function merge3(kind: FileKind, at: Segment[], b: unknown, o: unknown, t: unknown, out: FieldConflict[]): unknown {
  if (deepEqual(o, t)) return o
  if (deepEqual(o, b)) return t
  if (deepEqual(t, b)) return o

  const conflict = (): unknown => {
    out.push({ path: JSON.stringify(at), label: labelFor(kind, at), ours: o, theirs: t, base: b })
    return o !== undefined ? o : t
  }

  if (isObject(o) && isObject(t)) {
    const top = at.length === 1 ? at[0] : undefined
    if (kind === 'request' && top === 'body' && o.mode !== t.mode) return conflict()
    if ((kind === 'request' || kind === 'collection') && top === 'auth' && o.type !== t.type) return conflict()
    return mergeObjects(kind, at, isObject(b) ? b : undefined, o, t, out)
  }

  if (Array.isArray(o) && Array.isArray(t) && (b === undefined || Array.isArray(b))) {
    const baseArr = b ?? []
    if (isOrderArray(kind, at) && [baseArr, o, t].every((a) => a.every((x) => typeof x === 'string'))) {
      return mergeOrder(baseArr as string[], o as string[], t as string[])
    }
    if (isKeyedArray(kind, at) && [baseArr, o, t].every(hasUniqueKeys)) {
      return mergeKeyed(kind, at, baseArr as Keyed[], o as Keyed[], t as Keyed[], out)
    }
  }

  return conflict()
}

function mergeObjects(
  kind: FileKind,
  at: Segment[],
  b: Record<string, unknown> | undefined,
  o: Record<string, unknown>,
  t: Record<string, unknown>,
  out: FieldConflict[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const keys = [...Object.keys(t), ...Object.keys(o).filter((k) => !(k in t))]
  for (const k of keys) {
    const v = merge3(kind, [...at, k], b?.[k], o[k], t[k], out)
    if (v !== undefined) result[k] = v
  }
  return result
}

type Keyed = Record<string, unknown> & { key: string }

function hasUniqueKeys(arr: unknown[]): boolean {
  const seen = new Set<string>()
  for (const el of arr) {
    if (!isObject(el) || typeof el.key !== 'string' || seen.has(el.key)) return false
    seen.add(el.key)
  }
  return true
}

/** Theirs' order, then ours' additions in ours' relative order. */
function unionOrder(o: string[], t: string[]): string[] {
  const inTheirs = new Set(t)
  return [...t, ...o.filter((k) => !inTheirs.has(k))]
}

function mergeKeyed(
  kind: FileKind,
  at: Segment[],
  b: Keyed[],
  o: Keyed[],
  t: Keyed[],
  out: FieldConflict[]
): Keyed[] {
  const byKey = (arr: Keyed[]): Map<string, Keyed> => new Map(arr.map((el) => [el.key, el]))
  const [bm, om, tm] = [byKey(b), byKey(o), byKey(t)]
  const result: Keyed[] = []
  for (const key of unionOrder(
    o.map((el) => el.key),
    t.map((el) => el.key)
  )) {
    const v = merge3(kind, [...at, { key }], bm.get(key), om.get(key), tm.get(key), out)
    if (v !== undefined) result.push(v as Keyed)
  }
  return result
}

/** A union of entries: theirs' order, then ours' additions; removals on either side are applied. */
function mergeOrder(b: string[], o: string[], t: string[]): string[] {
  const inBase = new Set(b)
  const removed = new Set([...b.filter((x) => !o.includes(x)), ...b.filter((x) => !t.includes(x))])
  const ourAdditions = o.filter((x) => !inBase.has(x))
  return [...new Set([...t, ...ourAdditions])].filter((x) => !removed.has(x))
}

// --- labels ----------------------------------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  id: 'ID',
  name: 'Name',
  method: 'Method',
  url: 'URL',
  params: 'Query params',
  headers: 'Headers',
  body: 'Body',
  auth: 'Auth',
  scripts: 'Scripts',
  'scripts.preRequest': 'Pre-request script',
  'scripts.postResponse': 'Post-response script',
  variables: 'Variables',
  order: 'Order',
  version: 'Version'
}

function elementLabel(kind: FileKind, arrayPath: string, key: string): string {
  if (kind === 'request' && arrayPath === 'params') return `Query param "${key}"`
  if (kind === 'request' && arrayPath === 'headers') return `Header "${key}"`
  if (kind === 'request' && arrayPath === 'body.fields') return `Body field "${key}"`
  return `Variable "${key}"`
}

function labelFor(kind: FileKind, at: Segment[]): string {
  const keyed = at.findIndex((s) => typeof s !== 'string')
  if (keyed >= 0) {
    const label = elementLabel(kind, fieldPath(at.slice(0, keyed)), (at[keyed] as { key: string }).key)
    const field = fieldPath(at.slice(keyed + 1))
    return field === '' || field === 'value' ? label : `${label} (${field})`
  }
  const p = fieldPath(at)
  if (p === '') return 'File'
  if (FIELD_LABELS[p]) return FIELD_LABELS[p]
  if (at[0] === 'body' && kind === 'request') return 'Body'
  if (at[0] === 'auth') return 'Auth'
  return p
}

// --- applying choices ------------------------------------------------------------------------------------------

/** Sets (or, for `undefined`, removes) the value at `at` and returns the new root. */
function setAt(root: unknown, at: Segment[], value: unknown): unknown {
  if (at.length === 0) return value
  let parent: unknown = root
  for (const seg of at.slice(0, -1)) parent = childOf(parent, seg)
  const last = at[at.length - 1]
  if (typeof last === 'string') {
    if (!isObject(parent)) throw new Error(`Cannot apply a merge choice at ${JSON.stringify(at)}`)
    if (value === undefined) delete parent[last]
    else parent[last] = value
    return root
  }
  if (!Array.isArray(parent)) throw new Error(`Cannot apply a merge choice at ${JSON.stringify(at)}`)
  const i = parent.findIndex((el) => isObject(el) && el.key === last.key)
  if (i < 0) {
    if (value !== undefined) parent.push(value)
  } else if (value === undefined) {
    parent.splice(i, 1)
  } else {
    parent[i] = value
  }
  return root
}

function childOf(parent: unknown, seg: Segment): unknown {
  const child =
    typeof seg === 'string'
      ? isObject(parent)
        ? parent[seg]
        : undefined
      : Array.isArray(parent)
        ? parent.find((el) => isObject(el) && el.key === seg.key)
        : undefined
  if (child === undefined) throw new Error('Cannot apply a merge choice: the merged document has no such field')
  return child
}
