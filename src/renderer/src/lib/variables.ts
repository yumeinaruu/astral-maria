import type { CollectionTree, Environment } from '../../../shared/types'
import { GLOBALS_ID } from './environments'

/** Where a `{{variable}}` gets its value; the first scope that has the name wins, as when sending. */
export type VariableSource = 'environment' | 'collection' | 'globals'

export interface Resolution {
  name: string
  value: string
  secret: boolean
  source: VariableSource
  /** Name of the environment or collection the value comes from. */
  scopeName: string
}

interface Scope {
  source: VariableSource
  name: string
  values: Map<string, { value: string; secret: boolean }>
}

/** Resolves one variable name, or returns null when no scope has it. */
export type VariableLookup = (name: string) => Resolution | null

function environmentScope(env: Environment | undefined, source: VariableSource): Scope | null {
  if (!env) return null
  const values = new Map<string, { value: string; secret: boolean }>()
  for (const v of env.variables) {
    if (v.enabled) values.set(v.key, { value: v.currentValue !== undefined ? v.currentValue : v.value, secret: v.secret })
  }
  return { source, name: env.name, values }
}

function collectionScope(collection: CollectionTree | undefined): Scope | null {
  if (!collection) return null
  const values = new Map<string, { value: string; secret: boolean }>()
  for (const v of collection.variables) if (v.enabled) values.set(v.key, { value: v.value, secret: false })
  return { source: 'collection', name: collection.name, values }
}

/** The scopes in the order sending applies them: the active environment, the request's collection, the globals. */
function scopesOf(
  environments: Environment[],
  activeEnvironmentId: string | null,
  collection: CollectionTree | undefined,
): Scope[] {
  return [
    environmentScope(
      activeEnvironmentId === null ? undefined : environments.find((e) => e.id === activeEnvironmentId),
      'environment',
    ),
    collectionScope(collection),
    environmentScope(
      environments.find((e) => e.id === GLOBALS_ID),
      'globals',
    ),
  ].filter((s): s is Scope => s !== null)
}

/**
 * The lookup the main process applies when sending: the active environment, then the request's collection, then the
 * globals. Only saved environments count, as only those are sent.
 */
export function variableLookup(
  environments: Environment[],
  activeEnvironmentId: string | null,
  collection: CollectionTree | undefined,
): VariableLookup {
  const scopes = scopesOf(environments, activeEnvironmentId, collection)
  return (name) => {
    for (const scope of scopes) {
      const hit = scope.values.get(name)
      if (hit) return { name, value: hit.value, secret: hit.secret, source: scope.source, scopeName: scope.name }
    }
    return null
  }
}

/** Every enabled variable the request can use, once each, with the value and scope that win when sending. */
export function variableOptions(
  environments: Environment[],
  activeEnvironmentId: string | null,
  collection: CollectionTree | undefined,
): Resolution[] {
  const seen = new Map<string, Resolution>()
  for (const scope of scopesOf(environments, activeEnvironmentId, collection)) {
    for (const [name, hit] of scope.values) {
      if (name !== '' && !seen.has(name)) {
        seen.set(name, { name, value: hit.value, secret: hit.secret, source: scope.source, scopeName: scope.name })
      }
    }
  }
  return [...seen.values()]
}

export interface Segment {
  text: string
  /** Set on a `{{…}}` token: the variable name it refers to, or '' when it cannot name a variable. */
  variable?: string
}

const TOKEN = /\{\{[^{}]*\}\}/g

export function hasVariables(text: string): boolean {
  return text.includes('{{') && /\{\{[^{}]*\}\}/.test(text)
}

/** Splits `text` into plain runs and `{{variable}}` tokens; joining the texts gives `text` back. */
export function segmentsOf(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index
    if (at > last) out.push({ text: text.slice(last, at) })
    const inner = match[0].slice(2, -2).trim()
    // Names with whitespace never resolve when sending, so they count as missing.
    out.push({ text: match[0], variable: /\s/.test(inner) ? '' : inner })
    last = at + match[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

export const MASK = '••••'

export const SOURCE_LABELS: Record<VariableSource, string> = {
  environment: 'Environment',
  collection: 'Collection',
  globals: 'Globals',
}
