import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWorkspace, openWorkspace } from '../../src/main/storage/workspaceStore'

let dir: string
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'am-ws-'))
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('createWorkspace', () => {
  it('creates the layout', async () => {
    const info = await createWorkspace(dir, 'My WS')
    expect(info.name).toBe('My WS')
    expect(info.dir).toBe(dir)
    expect(info.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'workspace.json'), 'utf8'))
    expect(meta).toEqual({ version: 1, id: info.id, name: 'My WS' })
    expect((await fsp.stat(path.join(dir, 'collections'))).isDirectory()).toBe(true)
    expect((await fsp.stat(path.join(dir, 'environments'))).isDirectory()).toBe(true)
    const gi = await fsp.readFile(path.join(dir, '.gitignore'), 'utf8')
    expect(gi.split('\n')).toContain('.local/')
  })

  it('rejects over an existing workspace', async () => {
    await createWorkspace(dir, 'A')
    await expect(createWorkspace(dir, 'B')).rejects.toThrow()
  })
})

describe('openWorkspace', () => {
  it('opens a created workspace', async () => {
    const info = await createWorkspace(dir, 'A')
    expect(await openWorkspace(dir)).toEqual(info)
  })

  it('rejects a plain folder', async () => {
    await expect(openWorkspace(dir)).rejects.toThrow('not_a_workspace')
  })

  it('appends .local/ to .gitignore without touching other lines', async () => {
    await createWorkspace(dir, 'A')
    await fsp.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n*.log')
    await openWorkspace(dir)
    expect(await fsp.readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n*.log\n.local/\n')
  })

  it('creates .gitignore when missing', async () => {
    await createWorkspace(dir, 'A')
    await fsp.rm(path.join(dir, '.gitignore'))
    await openWorkspace(dir)
    expect(await fsp.readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('.local/\n')
  })
})
