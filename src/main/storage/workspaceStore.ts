import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { WorkspaceInfo } from '../../shared/types'
import { CorruptFileError, readJson, writeJsonAtomic } from './fsJson'

interface WorkspaceFile {
  version: 1
  id: string
  name: string
}

const LOCAL_IGNORE = '.local/'
const META_FILE = 'workspace.json'

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function ensureGitignore(dir: string): Promise<void> {
  const file = path.join(dir, '.gitignore')
  let text = ''
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (text.split(/\r?\n/).includes(LOCAL_IGNORE)) return
  const sep = text === '' || text.endsWith('\n') ? '' : '\n'
  await fs.writeFile(file, `${text}${sep}${LOCAL_IGNORE}\n`, 'utf8')
}

export async function createWorkspace(dir: string, name: string): Promise<WorkspaceInfo> {
  const metaPath = path.join(dir, META_FILE)
  if (await exists(metaPath)) throw new Error('workspace_exists')
  await fs.mkdir(path.join(dir, 'collections'), { recursive: true })
  await fs.mkdir(path.join(dir, 'environments'), { recursive: true })
  const meta: WorkspaceFile = { version: 1, id: randomUUID(), name }
  await writeJsonAtomic(metaPath, meta)
  await ensureGitignore(dir)
  return { id: meta.id, name, dir }
}

/** Reads and validates `workspace.json` only; writes nothing, so it is safe for folders the user did not open. */
export async function readWorkspaceInfo(dir: string): Promise<WorkspaceInfo> {
  const metaPath = path.join(dir, META_FILE)
  let meta: unknown
  try {
    meta = await readJson<unknown>(metaPath, META_FILE)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('not_a_workspace')
    throw e
  }
  if (
    typeof meta !== 'object' ||
    meta === null ||
    Array.isArray(meta) ||
    typeof (meta as Record<string, unknown>).id !== 'string' ||
    (meta as Record<string, unknown>).id === '' ||
    typeof (meta as Record<string, unknown>).name !== 'string'
  ) {
    throw new CorruptFileError(metaPath, `Invalid workspace metadata in ${META_FILE}`)
  }
  const { id, name } = meta as WorkspaceFile
  return { id, name, dir }
}

export async function openWorkspace(dir: string): Promise<WorkspaceInfo> {
  const info = await readWorkspaceInfo(dir)
  await ensureGitignore(dir)
  return info
}
