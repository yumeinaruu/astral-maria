import { readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toPostmanCollection, toPostmanEnvironment } from '../../src/main/postman/exporter'
import { CollectionStore } from '../../src/main/storage/collectionStore'
import { EnvironmentStore } from '../../src/main/storage/environmentStore'
import {
  exportCollection,
  exportEnvironment,
  importFiles,
  importText,
  MAX_IMPORT_BYTES,
  mergeGlobals,
  type Stores,
} from '../../src/main/transfer'
import type { EnvVar } from '../../src/shared/types'

const cipher = {
  encrypt: (s: string) => `x:${s}`,
  decrypt: (s: string) => s.replace(/^x:/, ''),
}

const fixturePath = (name: string) => path.resolve(__dirname, '../fixtures/postman', name)
const fixture = (name: string) => readFileSync(fixturePath(name), 'utf8')

let dir: string
let out: string
let stores: Stores

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'am-transfer-'))
  out = await fsp.mkdtemp(path.join(os.tmpdir(), 'am-transfer-out-'))
  stores = { collections: new CollectionStore(dir), environments: new EnvironmentStore(dir, cipher) }
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.rm(out, { recursive: true, force: true })
})

/** Every file under the workspace, relative, sorted. */
async function filesIn(root: string): Promise<string[]> {
  const entries = await fsp.readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort()
}

const v = (key: string, value: string, over: Partial<EnvVar> = {}): EnvVar => ({
  key,
  value,
  secret: false,
  enabled: true,
  ...over,
})

describe('importText', () => {
  it('imports a collection and reports it', async () => {
    const report = await importText(stores, fixture('full.v21.postman_collection.json'), 'full.json')
    expect(report.failed).toEqual([])
    expect(report.imported).toHaveLength(1)
    const [item] = report.imported
    expect(item).toMatchObject({ source: 'full.json', kind: 'collection' })
    const { collections } = await stores.collections.list()
    expect(collections.map((c) => c.name)).toEqual([item.name])
    expect(item.warnings).toEqual(expect.any(Array))
  })

  it('imports an environment with a fresh id, keeping secrets out of the committed file', async () => {
    const report = await importText(stores, fixture('dev.postman_environment.json'), 'dev.json')
    expect(report).toEqual({
      imported: [{ source: 'dev.json', kind: 'environment', name: 'Dev', warnings: [] }],
      failed: [],
    })
    const { environments } = await stores.environments.list()
    expect(environments).toHaveLength(1)
    const [env] = environments
    expect(env.id).not.toBe('8a2e4f6c-1d3b-4c5e-9f70-2b4d6e8f0a13')
    expect(env.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(env.variables.find((x) => x.key === 'token')).toMatchObject({
      value: '',
      currentValue: 'dev-token-123',
      secret: true,
    })

    const committed = await fsp.readFile(path.join(dir, 'environments/dev.json'), 'utf8')
    expect(committed).not.toContain('dev-token-123')
    expect(JSON.parse(committed).variables.find((x: EnvVar) => x.key === 'token').value).toBe('')
    const local = await fsp.readFile(path.join(dir, '.local/environments/dev.json'), 'utf8')
    expect(JSON.parse(local).values.token).toBe('x:dev-token-123')
  })

  it('imports the same environment twice as two environments', async () => {
    await importText(stores, fixture('dev.postman_environment.json'), 'a')
    await importText(stores, fixture('dev.postman_environment.json'), 'b')
    const { environments } = await stores.environments.list()
    expect(environments.map((e) => e.name)).toEqual(['Dev', 'Dev'])
    expect(new Set(environments.map((e) => e.id)).size).toBe(2)
  })

  it('creates the globals environment when it is missing', async () => {
    const report = await importText(stores, fixture('workspace.postman_globals.json'), 'g.json')
    expect(report.imported).toEqual([{ source: 'g.json', kind: 'globals', name: 'Workspace Globals', warnings: [] }])
    const { environments } = await stores.environments.list()
    expect(environments).toHaveLength(1)
    expect(environments[0]).toMatchObject({ id: 'globals', name: 'Globals' })
    expect(environments[0].variables).toEqual([
      v('tenant', 'acme'),
      { key: 'signing_key', value: '', currentValue: 'k-987', secret: true, enabled: false },
    ])
    const committed = await fsp.readFile(path.join(dir, 'environments/globals.json'), 'utf8')
    expect(committed).not.toContain('k-987')
  })

  it('merges globals into the existing globals environment', async () => {
    await stores.environments.save({
      id: 'globals',
      name: 'Globals',
      variables: [v('keep', '1'), v('tenant', 'old', { currentValue: 'mine', local: true })],
    })
    await importText(stores, fixture('workspace.postman_globals.json'), 'g.json')
    const globals = (await stores.environments.list()).environments.find((e) => e.id === 'globals')
    expect(globals?.variables).toEqual([
      v('keep', '1'),
      v('tenant', 'acme', { local: true }),
      { key: 'signing_key', value: '', currentValue: 'k-987', secret: true, enabled: false },
    ])
  })

  it('rejects text over the size limit, counting UTF-8 bytes, and writes nothing', async () => {
    const text = '€'.repeat(Math.floor(MAX_IMPORT_BYTES / 3) + 1)
    expect(text.length).toBeLessThan(MAX_IMPORT_BYTES)
    const report = await importText(stores, text, 'Pasted text')
    expect(report.imported).toEqual([])
    expect(report.failed).toEqual([{ source: 'Pasted text', message: expect.stringContaining('50 MB') }])
    expect(await filesIn(dir)).toEqual([])
  })

  it('reports what parsePostman rejects and writes nothing', async () => {
    for (const [text, message] of [
      ['not json', 'Not valid JSON'],
      ['[]', 'Not a Postman'],
      ['null', 'Not a Postman'],
      [fixture('v1.postman_collection.json'), 'v1 is not supported'],
      [fixture('dump.json'), 'data dump'],
    ]) {
      const report = await importText(stores, text, 'x.json')
      expect(report.imported).toEqual([])
      expect(report.failed).toEqual([{ source: 'x.json', message: expect.stringContaining(message) }])
    }
    expect(await filesIn(dir)).toEqual([])
  })

  it('imports a file that starts with a BOM', async () => {
    const report = await importText(stores, `\uFEFF${fixture('dev.postman_environment.json')}`, 'bom.json')
    expect(report.failed).toEqual([])
    expect(report.imported[0].kind).toBe('environment')
  })
})

describe('mergeGlobals', () => {
  it('replaces value, secret, enabled and current value of matching keys, appends new ones and keeps the rest', () => {
    const existing = [
      v('a', '1'),
      v('b', '2', { currentValue: 'cur', local: true }),
      v('s', '', { secret: true, locked: true, lockedKey: 's' }),
    ]
    const imported = [
      v('b', 'two', { enabled: false }),
      v('s', '', { secret: true, currentValue: 'new' }),
      v('c', '3', { secret: true, currentValue: 'shh', value: '' }),
    ]
    expect(mergeGlobals(existing, imported)).toEqual([
      v('a', '1'),
      v('b', 'two', { enabled: false, local: true }),
      v('s', '', { secret: true, currentValue: 'new' }),
      v('c', '', { secret: true, currentValue: 'shh' }),
    ])
  })

  it('does not change its inputs', () => {
    const existing = [v('a', '1')]
    const imported = [v('a', '2')]
    mergeGlobals(existing, imported)
    expect(existing).toEqual([v('a', '1')])
    expect(imported).toEqual([v('a', '2')])
  })
})

describe('importFiles', () => {
  it('reads every path in order and names each by its file name', async () => {
    const report = await importFiles(stores, [
      fixturePath('dev.postman_environment.json'),
      fixturePath('full.v21.postman_collection.json'),
    ])
    expect(report.failed).toEqual([])
    expect(report.imported.map((i) => [i.source, i.kind])).toEqual([
      ['dev.postman_environment.json', 'environment'],
      ['full.v21.postman_collection.json', 'collection'],
    ])
  })

  it('imports two files holding collections of the same name into distinct directories', async () => {
    const file = fixturePath('full.v21.postman_collection.json')
    const report = await importFiles(stores, [file, file])
    expect(report.imported).toHaveLength(2)
    const { collections } = await stores.collections.list()
    expect(collections).toHaveLength(2)
    expect(collections[0].name).toBe(collections[1].name)
    expect(collections[0].path).not.toBe(collections[1].path)
  })

  it('rejects a file over the limit after stat, without reading it, and goes on with the rest', async () => {
    const big = path.join(out, 'big.json')
    await fsp.writeFile(big, '')
    await fsp.truncate(big, MAX_IMPORT_BYTES + 1)
    const report = await importFiles(stores, [big, fixturePath('dev.postman_environment.json')])
    expect(report.failed).toEqual([{ source: 'big.json', message: expect.stringContaining('50 MB') }])
    expect(report.imported.map((i) => i.source)).toEqual(['dev.postman_environment.json'])
  })

  it('reports a file that cannot be read', async () => {
    const report = await importFiles(stores, [path.join(out, 'missing.json')])
    expect(report.imported).toEqual([])
    expect(report.failed).toEqual([{ source: 'missing.json', message: expect.any(String) }])
  })
})

describe('exportCollection', () => {
  it('writes Collection v2.1 to the picked path and resolves that path', async () => {
    const tree = await stores.collections.importCollection({
      name: 'My: API',
      variables: [],
      auth: { type: 'none' },
      children: [],
    })
    const asked: string[] = []
    const target = path.join(out, 'picked.json')
    const result = await exportCollection(stores, tree.path, async (name) => {
      asked.push(name)
      return target
    })
    expect(result).toBe(target)
    expect(asked).toEqual(['My_ API.postman_collection.json'])
    const listed = (await stores.collections.list()).collections[0]
    expect(await fsp.readFile(target, 'utf8')).toBe(JSON.stringify(toPostmanCollection(listed), null, 2))
  })

  it('writes nothing when the dialog is cancelled', async () => {
    const tree = await stores.collections.createCollection('C')
    expect(await exportCollection(stores, tree.path, async () => null)).toBeNull()
    expect(await fsp.readdir(out)).toEqual([])
  })

  it('rejects an unknown collection path without asking', async () => {
    let asked = false
    const pick = async () => {
      asked = true
      return path.join(out, 'x.json')
    }
    await expect(exportCollection(stores, 'collections/nope', pick)).rejects.toThrow('collection_not_found')
    expect(asked).toBe(false)
  })
})

describe('exportEnvironment', () => {
  it('writes the environment with empty secrets to the picked path', async () => {
    await stores.environments.save({
      id: 'e1',
      name: 'Staging',
      variables: [v('host', 'h'), v('pw', '', { secret: true, currentValue: 'hunter2' })],
    })
    const asked: string[] = []
    const target = path.join(out, 'env.json')
    const result = await exportEnvironment(stores, 'e1', async (name) => {
      asked.push(name)
      return target
    })
    expect(result).toBe(target)
    expect(asked).toEqual(['Staging.postman_environment.json'])
    const env = (await stores.environments.list()).environments[0]
    const text = await fsp.readFile(target, 'utf8')
    expect(text).toBe(JSON.stringify(toPostmanEnvironment(env), null, 2))
    expect(text).not.toContain('hunter2')
  })

  it('names the globals by their own suffix', async () => {
    await stores.environments.save({ id: 'globals', name: 'Globals', variables: [v('a', '1')] })
    const asked: string[] = []
    await exportEnvironment(stores, 'globals', async (name) => {
      asked.push(name)
      return null
    })
    expect(asked).toEqual(['Globals.postman_globals.json'])
  })

  it('exports empty globals when no globals file exists yet', async () => {
    const target = path.join(out, 'g.json')
    expect(await exportEnvironment(stores, 'globals', async () => target)).toBe(target)
    const doc = JSON.parse(await fsp.readFile(target, 'utf8'))
    expect(doc).toMatchObject({ name: 'Globals', values: [], _postman_variable_scope: 'globals' })
  })

  it('writes nothing when the dialog is cancelled', async () => {
    await stores.environments.save({ id: 'e1', name: 'E', variables: [] })
    expect(await exportEnvironment(stores, 'e1', async () => null)).toBeNull()
    expect(await fsp.readdir(out)).toEqual([])
  })

  it('rejects an unknown id', async () => {
    await expect(exportEnvironment(stores, 'nope', async () => path.join(out, 'x.json'))).rejects.toThrow(
      'environment_not_found',
    )
  })
})
