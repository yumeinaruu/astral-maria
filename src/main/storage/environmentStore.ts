import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { EnvVar, Environment, LoadError } from '../../shared/types'
import { CorruptFileError, readJson, writeJsonAtomic } from './fsJson'
import { slugify, uniqueSlug } from './slug'

const ENV_DIR = 'environments'
const LOCAL_ENV_DIR = '.local/environments'
const GLOBALS_ID = 'globals'
const GLOBALS_SLUG = 'globals'
const SUFFIX = '.json'
/** Leaves room for `-NNN` and `.json` within the 255-byte file name limit. */
const MAX_SLUG_BYTES = 200

export interface SecretCipher {
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

interface Committed {
  id: string
  name: string
  variables: EnvVar[]
}

interface Entry {
  /** File name without the `.json` suffix. */
  slug: string
  env: Committed
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Only a shortened slug loses trailing dashes: `slugify` ends a reserved name like `con` with one on purpose. */
function capSlug(slug: string): string {
  if (Buffer.byteLength(slug) <= MAX_SLUG_BYTES) return slug
  let out = slug
  while (Buffer.byteLength(out) > MAX_SLUG_BYTES) out = Array.from(out).slice(0, -1).join('')
  return out.replace(/-+$/g, '') || 'untitled'
}

function invalid(file: string, what: string): never {
  throw new CorruptFileError(file, `Invalid ${what} in ${file}`)
}

function checkEnvironment(v: unknown, file: string): Committed {
  if (!isObject(v) || typeof v.id !== 'string' || typeof v.name !== 'string' || !Array.isArray(v.variables)) {
    invalid(file, 'environment')
  }
  const variables = v.variables.map((raw: unknown): EnvVar => {
    if (
      !isObject(raw) ||
      typeof raw.key !== 'string' ||
      typeof raw.value !== 'string' ||
      (raw.secret !== undefined && typeof raw.secret !== 'boolean') ||
      (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
    ) {
      invalid(file, 'environment variable')
    }
    return {
      key: raw.key,
      value: raw.value,
      secret: raw.secret ?? false,
      enabled: raw.enabled ?? true
    }
  })
  return { id: v.id, name: v.name, variables }
}

/** A `.local` file: current values (secrets encrypted) and the keys of non-secret variables marked local. */
interface Local {
  values: Record<string, string>
  local: string[]
}

function checkLocal(v: unknown, file: string): Local {
  if (
    !isObject(v) ||
    !isObject(v.values) ||
    !Object.values(v.values).every((x) => typeof x === 'string') ||
    (v.local !== undefined && !(Array.isArray(v.local) && v.local.every((x) => typeof x === 'string')))
  ) {
    invalid(file, 'local values')
  }
  return { values: v.values as Record<string, string>, local: (v.local as string[] | undefined) ?? [] }
}

/** Environments live in `environments/`; secrets and current values only in the git-ignored `.local/`. */
export class EnvironmentStore {
  private readonly root: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    workspaceDir: string,
    private readonly cipher: SecretCipher
  ) {
    this.root = path.resolve(workspaceDir)
  }

  /** Serializes mutations; a failed call does not poison the chain. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn)
    this.queue = result.catch(() => undefined)
    return result
  }

  async list(): Promise<{ environments: Environment[]; errors: LoadError[] }> {
    const errors: LoadError[] = []
    const environments: Environment[] = []
    for (const slug of await this.slugs()) {
      const rel = this.committedRel(slug)
      let committed: Committed
      try {
        committed = checkEnvironment(await readJson<unknown>(this.abs(rel), rel), rel)
      } catch (e) {
        errors.push({ path: rel, message: errorMessage(e) })
        continue
      }
      environments.push(await this.withLocalValues(slug, committed, errors))
    }
    return { environments, errors }
  }

  save(env: Environment): Promise<void> {
    return this.exclusive(async () => {
      this.checkId(env.id)
      const slug = await this.slugFor(env)
      const localRel = this.localRel(slug)
      const localAbs = this.abs(localRel)
      const committed: Committed = {
        id: env.id,
        name: env.name,
        variables: env.variables.map((v) => ({
          key: v.key,
          value: v.secret ? '' : v.value,
          secret: v.secret,
          enabled: v.enabled
        }))
      }
      // A damaged .local file is left alone rather than silently replaced.
      let localExists = true
      let stored: Record<string, string> = {}
      try {
        stored = checkLocal(await readJson<unknown>(localAbs, localRel), localRel).values
      } catch (e) {
        if (!isMissing(e)) throw e
        localExists = false
      }

      const values: Record<string, string> = {}
      for (const v of env.variables) {
        if (v.currentValue) {
          values[v.key] = v.secret ? this.cipher.encrypt(v.currentValue) : v.currentValue
        } else if (v.secret && v.locked === true) {
          // A secret this machine cannot decrypt (Keychain denied or reset) is kept as is unless it was replaced; a
          // renamed one carries the key it was stored under.
          const from = typeof v.lockedKey === 'string' ? v.lockedKey : v.key
          if (Object.hasOwn(stored, from)) values[v.key] = stored[from]
        }
      }

      const local = env.variables.filter((v) => v.local === true && !v.secret).map((v) => v.key)

      if (Object.keys(values).length > 0 || local.length > 0) {
        await fs.mkdir(path.dirname(localAbs), { recursive: true })
        await writeJsonAtomic(localAbs, local.length > 0 ? { values, local } : { values })
      } else if (localExists) {
        await fs.rm(localAbs, { force: true })
      }
      await fs.mkdir(this.abs(ENV_DIR), { recursive: true })
      await writeJsonAtomic(this.abs(this.committedRel(slug)), committed)
    })
  }

  remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      this.checkId(id)
      const entry = await this.find(id)
      if (!entry) return
      await fs.rm(this.abs(this.committedRel(entry.slug)), { force: true })
      await fs.rm(this.abs(this.localRel(entry.slug)), { force: true })
    })
  }

  async resolvedValues(id: string): Promise<Record<string, string>> {
    const env = (await this.list()).environments.find((e) => e.id === id)
    if (!env) throw new Error('environment_not_found')
    const out: Record<string, string> = {}
    for (const v of env.variables) {
      if (v.enabled) out[v.key] = v.currentValue ? v.currentValue : v.value
    }
    return out
  }

  // ---- helpers ----

  private abs(rel: string): string {
    return path.join(this.root, rel)
  }

  private committedRel(slug: string): string {
    return `${ENV_DIR}/${slug}${SUFFIX}`
  }

  private localRel(slug: string): string {
    return `${LOCAL_ENV_DIR}/${slug}${SUFFIX}`
  }

  /** Ids are only looked up, never used as file names; this rejects anything that looks like a path. */
  private checkId(id: unknown): void {
    if (typeof id !== 'string' || id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new Error('invalid_id')
    }
  }

  /** File name stems of `environments/*.json`, sorted. */
  private async slugs(): Promise<string[]> {
    let names: string[]
    try {
      const entries = await fs.readdir(this.abs(ENV_DIR), {
        withFileTypes: true
      })
      names = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name)
    } catch (e) {
      if (isMissing(e)) return []
      throw e
    }
    return names
      .filter((n) => n.endsWith(SUFFIX))
      .map((n) => n.slice(0, -SUFFIX.length))
      .sort(compare)
  }

  /** Finds the file holding the environment with this id; unreadable files cannot match. */
  private async find(id: string): Promise<Entry | undefined> {
    for (const slug of await this.slugs()) {
      try {
        const rel = this.committedRel(slug)
        const env = checkEnvironment(await readJson<unknown>(this.abs(rel), rel), rel)
        if (env.id === id) return { slug, env }
      } catch {
        // reported by list(); it cannot be the one we are looking for
      }
    }
    return undefined
  }

  private async slugFor(env: Environment): Promise<string> {
    if (env.id === GLOBALS_ID) {
      // Validating first guarantees a corrupt or hand-edited file is never overwritten.
      const rel = this.committedRel(GLOBALS_SLUG)
      try {
        const existing = checkEnvironment(await readJson<unknown>(this.abs(rel), rel), rel)
        if (existing.id !== GLOBALS_ID) invalid(rel, 'globals environment')
      } catch (e) {
        if (!isMissing(e)) throw e
      }
      return GLOBALS_SLUG
    }
    const existing = await this.find(env.id)
    if (existing) return existing.slug
    const taken = new Set([GLOBALS_SLUG, ...(await this.slugs())])
    return uniqueSlug(capSlug(slugify(env.name)), taken)
  }

  private async withLocalValues(slug: string, committed: Committed, errors: LoadError[]): Promise<Environment> {
    const rel = this.localRel(slug)
    let values: Record<string, string> = {}
    let localKeys = new Set<string>()
    try {
      const stored = checkLocal(await readJson<unknown>(this.abs(rel), rel), rel)
      values = stored.values
      localKeys = new Set(stored.local)
    } catch (e) {
      if (!isMissing(e)) errors.push({ path: rel, message: errorMessage(e) })
    }
    const variables = committed.variables.map((v): EnvVar => {
      const stored = Object.hasOwn(values, v.key) ? values[v.key] : undefined
      const local = !v.secret && localKeys.has(v.key) ? { local: true } : {}
      if (stored === undefined) return { ...v, ...local }
      if (!v.secret) return { ...v, currentValue: stored, ...local }
      try {
        return { ...v, currentValue: this.cipher.decrypt(stored) }
      } catch (e) {
        errors.push({
          path: rel,
          message: `Cannot decrypt "${v.key}" in ${rel}: ${errorMessage(e)}`
        })
        return { ...v, locked: true }
      }
    })
    return { id: committed.id, name: committed.name, variables }
  }
}
