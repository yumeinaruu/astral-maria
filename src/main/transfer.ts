import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { EnvVar, Environment, ImportReport } from '../shared/types'
import { exportFileName, toPostmanCollection, toPostmanEnvironment } from './postman/exporter'
import { parsePostman } from './postman/importer'
import type { CollectionStore } from './storage/collectionStore'
import type { EnvironmentStore } from './storage/environmentStore'

/** Files (and pasted text) larger than this, in UTF-8 bytes, are rejected before they are parsed. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024

const TOO_LARGE = 'Larger than the 50 MB import limit'
const GLOBALS_ID = 'globals'
const GLOBALS_NAME = 'Globals'

type PickExportPath = (defaultName: string) => Promise<string | null>
/** Wraps the write that follows the dialog, e.g. so a quit waits for it; the dialog itself is never wrapped. */
type Track = <T>(write: Promise<T>) => Promise<T>
const untracked: Track = (write) => write

export interface Stores {
  collections: CollectionStore
  environments: EnvironmentStore
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function emptyReport(): ImportReport {
  return { imported: [], failed: [] }
}

/**
 * The globals after an import: an imported key replaces the value, secret, enabled and current value of the existing
 * one (and any locked stored secret with it); new keys are appended, other keys are kept.
 */
export function mergeGlobals(existing: EnvVar[], imported: EnvVar[]): EnvVar[] {
  const out = existing.map((v) => ({ ...v }))
  for (const v of imported) {
    const replacement: EnvVar = { key: v.key, value: v.value, secret: v.secret, enabled: v.enabled }
    if (v.currentValue !== undefined) replacement.currentValue = v.currentValue
    const at = out.findIndex((e) => e.key === v.key)
    if (at === -1) {
      out.push(replacement)
    } else {
      // `local` is how this machine shows the variable, not part of the imported data.
      out[at] = out[at].local === undefined ? replacement : { ...replacement, local: out[at].local }
    }
  }
  return out
}

/** Imports one file's text into the stores; failures are reported, not thrown. */
export async function importText(stores: Stores, text: string, source: string): Promise<ImportReport> {
  const report = emptyReport()
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
    report.failed.push({ source, message: TOO_LARGE })
    return report
  }
  try {
    const parsed = parsePostman(text)
    if (parsed.kind === 'collection') {
      const tree = await stores.collections.importCollection(parsed.collection)
      report.imported.push({ source, kind: 'collection', name: tree.name, warnings: parsed.warnings })
    } else if (parsed.environment.scope === 'globals') {
      const current = (await stores.environments.list()).environments.find((e) => e.id === GLOBALS_ID)
      await stores.environments.save({
        id: GLOBALS_ID,
        name: current?.name ?? GLOBALS_NAME,
        variables: mergeGlobals(current?.variables ?? [], parsed.environment.variables),
      })
      report.imported.push({ source, kind: 'globals', name: parsed.environment.name, warnings: parsed.warnings })
    } else {
      const { name, variables } = parsed.environment
      await stores.environments.save({ id: randomUUID(), name, variables })
      report.imported.push({ source, kind: 'environment', name, warnings: parsed.warnings })
    }
  } catch (e) {
    report.failed.push({ source, message: errorMessage(e) })
  }
  return report
}

/** Imports each file in order, named in the report by its file name; a file over the limit is never read. */
export async function importFiles(stores: Stores, paths: string[]): Promise<ImportReport> {
  const report = emptyReport()
  for (const file of paths) {
    const source = path.basename(file)
    let text: string
    try {
      if ((await fs.stat(file)).size > MAX_IMPORT_BYTES) {
        report.failed.push({ source, message: TOO_LARGE })
        continue
      }
      text = await fs.readFile(file, 'utf8')
    } catch (e) {
      report.failed.push({ source, message: errorMessage(e) })
      continue
    }
    const one = await importText(stores, text, source)
    report.imported.push(...one.imported)
    report.failed.push(...one.failed)
  }
  return report
}

async function writeExport(
  doc: unknown,
  defaultName: string,
  pickExportPath: PickExportPath,
  track: Track,
): Promise<string | null> {
  const target = await pickExportPath(defaultName)
  if (target === null) return null
  await track(fs.writeFile(target, JSON.stringify(doc, null, 2), 'utf8'))
  return target
}

/** Asks where to save, then writes the collection as Collection v2.1; the written path, or null when cancelled. */
export async function exportCollection(
  stores: Stores,
  collectionPath: string,
  pickExportPath: PickExportPath,
  track: Track = untracked,
): Promise<string | null> {
  const tree = (await stores.collections.list()).collections.find((c) => c.path === collectionPath)
  if (!tree) throw new Error('collection_not_found')
  return writeExport(toPostmanCollection(tree), exportFileName(tree.name, 'collection'), pickExportPath, track)
}

/** Like `exportCollection`, for an environment or the globals; secrets are written empty. */
export async function exportEnvironment(
  stores: Stores,
  id: string,
  pickExportPath: PickExportPath,
  track: Track = untracked,
): Promise<string | null> {
  const env: Environment | undefined = (await stores.environments.list()).environments.find((e) => e.id === id)
  if (!env) throw new Error('environment_not_found')
  const kind = id === GLOBALS_ID ? 'globals' : 'environment'
  return writeExport(toPostmanEnvironment(env), exportFileName(env.name, kind), pickExportPath, track)
}
