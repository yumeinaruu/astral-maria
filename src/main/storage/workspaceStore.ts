import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { WorkspaceInfo } from '../../shared/types'
import { readJson, writeJsonAtomic } from './fsJson'

interface WorkspaceFile {
  version: 1
  id: string
  name: string
}

const LOCAL_IGNORE = '.local/'

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
  const metaPath = path.join(dir, 'workspace.json')
  if (await exists(metaPath)) throw new Error('workspace_exists')
  await fs.mkdir(path.join(dir, 'collections'), { recursive: true })
  await fs.mkdir(path.join(dir, 'environments'), { recursive: true })
  const meta: WorkspaceFile = { version: 1, id: randomUUID(), name }
  await writeJsonAtomic(metaPath, meta)
  await ensureGitignore(dir)
  return { id: meta.id, name, dir }
}

export async function openWorkspace(dir: string): Promise<WorkspaceInfo> {
  let meta: WorkspaceFile
  try {
    meta = await readJson<WorkspaceFile>(path.join(dir, 'workspace.json'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('not_a_workspace')
    throw e
  }
  await ensureGitignore(dir)
  return { id: meta.id, name: meta.name, dir }
}
