import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CollectionStore } from '../../src/main/storage/collectionStore'
import { CorruptFileError, writeJsonAtomic } from '../../src/main/storage/fsJson'
import type { ImportedCollection, ImportedNode } from '../../src/main/postman/importer'
import type { FolderNode, RequestItem, RequestNode, TreeNode } from '../../src/shared/types'

// Pass-through, so a test can make one write fail.
vi.mock('../../src/main/storage/fsJson', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/storage/fsJson')>()
  return { ...actual, writeJsonAtomic: vi.fn(actual.writeJsonAtomic) }
})

let dir: string
let store: CollectionStore
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'am-col-'))
  await fsp.mkdir(path.join(dir, 'collections'))
  store = new CollectionStore(dir)
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

const names = (nodes: { name: string }[]) => nodes.map((n) => n.name)
const read = (rel: string) => fsp.readFile(path.join(dir, rel), 'utf8')

describe('create and list', () => {
  it('lists a nested tree with workspace-relative paths', async () => {
    const col = await store.createCollection('My API')
    expect(col.path).toBe('collections/my-api')
    const folder = await store.createFolder(col.path, 'Users')
    expect(folder.path).toBe('collections/my-api/users')
    const req = await store.createRequest(folder.path, 'Login')
    expect(req.path).toBe('collections/my-api/users/login.request.json')
    expect(req.request).toMatchObject({
      name: 'Login',
      method: 'GET',
      url: '',
      params: [],
      headers: [],
      body: { mode: 'none' },
      auth: { type: 'inherit' }
    })

    const { collections, errors } = await store.list()
    expect(errors).toEqual([])
    expect(collections).toHaveLength(1)
    const c = collections[0]
    expect(c).toMatchObject({
      id: col.id,
      name: 'My API',
      path: 'collections/my-api',
      variables: []
    })
    const f = c.children[0] as FolderNode
    expect(f).toMatchObject({
      kind: 'folder',
      name: 'Users',
      path: 'collections/my-api/users'
    })
    const r = f.children[0] as RequestNode
    expect(r).toMatchObject({ kind: 'request', name: 'Login', path: req.path })
    expect(r.request.id).toBe(req.request.id)
  })

  it('writes 2-space JSON with a trailing newline', async () => {
    await store.createCollection('A')
    const text = await read('collections/a/collection.json')
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "order": []')
  })

  it('suffixes duplicate request names and ignores case', async () => {
    const col = await store.createCollection('C')
    await store.createRequest(col.path, 'Login')
    await store.createRequest(col.path, 'Login')
    await store.createRequest(col.path, 'LOGIN')
    const files = (await fsp.readdir(path.join(dir, col.path))).sort()
    expect(files).toEqual(['collection.json', 'login-2.request.json', 'login-3.request.json', 'login.request.json'])
  })

  it('keeps hostile names inside the parent', async () => {
    await store.createCollection('x')
    const req = await store.createRequest('collections/x', '../../evil')
    expect(req.path).toBe('collections/x/evil.request.json')
    expect(await fsp.readdir(dir)).toEqual(['collections'])
  })

  it('orders by order, then appends unlisted files alphabetically', async () => {
    const col = await store.createCollection('C')
    const b = await store.createRequest(col.path, 'B')
    await store.createRequest(col.path, 'A')
    const hand = { ...b.request, id: 'hand', name: 'Aardvark' }
    await fsp.writeFile(path.join(dir, col.path, 'aardvark.request.json'), JSON.stringify(hand))
    await fsp.writeFile(path.join(dir, col.path, 'zeta.request.json'), JSON.stringify({ ...hand, name: 'Zeta' }))
    await fsp.writeFile(path.join(dir, col.path, 'notes.txt'), 'stray')
    const { collections, errors } = await store.list()
    expect(errors).toEqual([])
    expect(names(collections[0].children)).toEqual(['B', 'A', 'Aardvark', 'Zeta'])
  })

  it('reorders with move: to front, to end, and clamped beyond the end', async () => {
    const col = await store.createCollection('C')
    await store.createRequest(col.path, 'A')
    await store.createRequest(col.path, 'B')
    const c = await store.createRequest(col.path, 'C')
    const order = async () => names((await store.list()).collections[0].children)
    expect(await order()).toEqual(['A', 'B', 'C'])
    expect(await store.move(c.path, col.path, 0)).toBe(c.path)
    expect(await order()).toEqual(['C', 'A', 'B'])
    await store.move(c.path, col.path, 2)
    expect(await order()).toEqual(['A', 'B', 'C'])
    await store.move('collections/c/a.request.json', col.path, 99)
    expect(await order()).toEqual(['B', 'C', 'A'])
    await store.move('collections/c/a.request.json', col.path, -5)
    expect(await order()).toEqual(['A', 'B', 'C'])
  })

  it('serializes concurrent creates in one folder', async () => {
    const col = await store.createCollection('C')
    const made = await Promise.all(Array.from({ length: 10 }, () => store.createRequest(col.path, 'Login')))
    const expected = ['login.request.json', ...Array.from({ length: 9 }, (_, i) => `login-${i + 2}.request.json`)]
    expect(made.map((m) => path.posix.basename(m.path))).toEqual(expected)
    expect(JSON.parse(await read('collections/c/collection.json')).order).toEqual(expected)
    expect((await fsp.readdir(path.join(dir, col.path))).sort()).toEqual([...expected, 'collection.json'].sort())
  })

  it('keeps working after a failed mutation', async () => {
    const col = await store.createCollection('C')
    const results = await Promise.allSettled([
      store.createRequest('collections/nope', 'X'),
      store.createRequest(col.path, 'Y')
    ])
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('fulfilled')
    expect(names((await store.list()).collections[0].children)).toEqual(['Y'])
  })

  it('ignores stale order entries and drops them on the next write', async () => {
    const col = await store.createCollection('C')
    await store.createRequest(col.path, 'A')
    const file = path.join(dir, col.path, 'collection.json')
    const meta = JSON.parse(await fsp.readFile(file, 'utf8'))
    meta.order = ['gone.request.json', ...meta.order]
    await fsp.writeFile(file, JSON.stringify(meta))
    expect(names((await store.list()).collections[0].children)).toEqual(['A'])
    await store.createRequest(col.path, 'B')
    expect(JSON.parse(await fsp.readFile(file, 'utf8')).order).toEqual(['a.request.json', 'b.request.json'])
  })
})

describe('rename', () => {
  it('renames a request file and its name field', async () => {
    const col = await store.createCollection('C')
    const req = await store.createRequest(col.path, 'Old')
    const next = await store.rename(req.path, 'New Name')
    expect(next).toBe('collections/c/new-name.request.json')
    await expect(fsp.access(path.join(dir, req.path))).rejects.toThrow()
    expect(JSON.parse(await read(next)).name).toBe('New Name')
    expect(JSON.parse(await read('collections/c/collection.json')).order).toEqual(['new-name.request.json'])
  })

  it('renames a folder directory and metadata, keeping its position', async () => {
    const col = await store.createCollection('C')
    await store.createFolder(col.path, 'A')
    const f = await store.createFolder(col.path, 'B')
    await store.createFolder(col.path, 'C')
    const next = await store.rename(f.path, 'Beta')
    expect(next).toBe('collections/c/beta')
    expect(JSON.parse(await read('collections/c/beta/folder.json')).name).toBe('Beta')
    expect(names((await store.list()).collections[0].children)).toEqual(['A', 'Beta', 'C'])
  })

  it('renames a collection', async () => {
    const col = await store.createCollection('Old')
    const next = await store.rename(col.path, 'Fresh')
    expect(next).toBe('collections/fresh')
    expect((await store.list()).collections[0].name).toBe('Fresh')
  })

  it('picks a unique name on collision', async () => {
    const col = await store.createCollection('C')
    await store.createRequest(col.path, 'A')
    const b = await store.createRequest(col.path, 'B')
    expect(await store.rename(b.path, 'a')).toBe('collections/c/a-2.request.json')
  })

  it('allows a case-only rename', async () => {
    const col = await store.createCollection('C')
    const r = await store.createRequest(col.path, 'login')
    expect(await store.rename(r.path, 'Login')).toBe(r.path)
    expect(JSON.parse(await read(r.path)).name).toBe('Login')
  })
})

describe('move', () => {
  it('moves into a folder at an index and returns the new path', async () => {
    const col = await store.createCollection('C')
    const f = await store.createFolder(col.path, 'F')
    await store.createRequest(f.path, 'X')
    const y = await store.createRequest(col.path, 'Y')
    const next = await store.move(y.path, f.path, 0)
    expect(next).toBe('collections/c/f/y.request.json')
    const tree = (await store.list()).collections[0]
    expect(names((tree.children[0] as FolderNode).children)).toEqual(['Y', 'X'])
    expect(tree.children).toHaveLength(1)
  })

  it('picks a unique name when the target already has one', async () => {
    const col = await store.createCollection('C')
    const f = await store.createFolder(col.path, 'F')
    await store.createRequest(f.path, 'Same')
    const s = await store.createRequest(col.path, 'Same')
    expect(await store.move(s.path, f.path, 5)).toBe('collections/c/f/same-2.request.json')
  })

  it('rejects moving a folder into itself or a descendant', async () => {
    const col = await store.createCollection('C')
    const a = await store.createFolder(col.path, 'A')
    const b = await store.createFolder(a.path, 'B')
    await expect(store.move(a.path, b.path, 0)).rejects.toThrow('cannot_move_into_descendant')
    await expect(store.move(a.path, a.path, 0)).rejects.toThrow('cannot_move_into_descendant')
  })

  it('does not treat a sibling with a shared name prefix as a descendant', async () => {
    const col = await store.createCollection('C')
    const a = await store.createFolder(col.path, 'a')
    const ab = await store.createFolder(col.path, 'ab')
    expect(await store.move(a.path, ab.path, 0)).toBe('collections/c/ab/a')
  })
})

describe('remove', () => {
  it('deletes a folder subtree and its order entry', async () => {
    const col = await store.createCollection('C')
    const f = await store.createFolder(col.path, 'F')
    await store.createRequest(f.path, 'X')
    await store.createRequest(col.path, 'Keep')
    await store.remove(f.path)
    await expect(fsp.access(path.join(dir, f.path))).rejects.toThrow()
    expect(JSON.parse(await read('collections/c/collection.json')).order).toEqual(['keep.request.json'])
  })
})

describe('path safety', () => {
  it('rejects paths outside the workspace or outside collections/', async () => {
    const col = await store.createCollection('C')
    const req = await store.createRequest(col.path, 'A')
    await expect(store.saveRequest('../x.request.json', req.request)).rejects.toThrow('path_outside_workspace')
    await expect(store.remove('../x')).rejects.toThrow('path_outside_workspace')
    await expect(store.remove('workspace.json')).rejects.toThrow('path_outside_workspace')
    await expect(store.remove('collections/../workspace.json')).rejects.toThrow('path_outside_workspace')
    await expect(store.rename('collections', 'x')).rejects.toThrow('path_outside_workspace')
    await expect(store.createFolder('/etc', 'x')).rejects.toThrow('path_outside_workspace')
  })
})

describe('saveRequest', () => {
  it('persists edits', async () => {
    const col = await store.createCollection('C')
    const r = await store.createRequest(col.path, 'A')
    const edited: RequestItem = {
      ...r.request,
      method: 'POST',
      url: 'https://example.test'
    }
    await store.saveRequest(r.path, edited)
    expect(JSON.parse(await read(r.path))).toEqual(edited)
    expect((await read(r.path)).endsWith('\n')).toBe(true)
  })
})

describe('revisions', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const listed = async (p: string) => {
    const find = (nodes: (FolderNode | RequestNode)[]): RequestNode | undefined => {
      for (const n of nodes) {
        if (n.kind === 'request' && n.path === p) return n
        if (n.kind === 'folder') {
          const hit = find(n.children)
          if (hit) return hit
        }
      }
      return undefined
    }
    for (const c of (await store.list()).collections) {
      const hit = find(c.children)
      if (hit) return hit
    }
    throw new Error(`not listed: ${p}`)
  }

  it('lists each request with the sha256 of its file bytes, also on create', async () => {
    const col = await store.createCollection('C')
    const r = await store.createRequest(col.path, 'A')
    expect(r.revision).toBe(sha(await read(r.path)))
    expect((await listed(r.path)).revision).toBe(r.revision)
    await fsp.writeFile(path.join(dir, r.path), JSON.stringify({ ...r.request, url: 'x' }))
    expect((await listed(r.path)).revision).toBe(sha(await read(r.path)))
  })

  it('saves when the expected revision matches and returns the new one', async () => {
    const col = await store.createCollection('C')
    const r = await store.createRequest(col.path, 'A')
    const next = await store.saveRequest(r.path, { ...r.request, url: 'one' }, r.revision)
    expect(next).toBe(sha(await read(r.path)))
    expect(next).not.toBe(r.revision)
    const third = await store.saveRequest(r.path, { ...r.request, url: 'two' }, next)
    expect(third).toBe(sha(await read(r.path)))
  })

  it('rejects with changed_on_disk and writes nothing when the file changed meanwhile', async () => {
    const col = await store.createCollection('C')
    const r = await store.createRequest(col.path, 'A')
    const resolved = JSON.stringify({ ...r.request, url: 'resolved by hand' }, null, 2)
    await fsp.writeFile(path.join(dir, r.path), resolved)
    await expect(store.saveRequest(r.path, { ...r.request, url: 'stale' }, r.revision)).rejects.toThrow(
      'changed_on_disk'
    )
    expect(await read(r.path)).toBe(resolved)
  })

  it('overwrites without an expected revision', async () => {
    const col = await store.createCollection('C')
    const r = await store.createRequest(col.path, 'A')
    await fsp.writeFile(path.join(dir, r.path), JSON.stringify({ ...r.request, url: 'external' }))
    await store.saveRequest(r.path, { ...r.request, url: 'mine' })
    expect(JSON.parse(await read(r.path)).url).toBe('mine')
  })

  it('still reports an unparsable file as corrupt, whatever the revision', async () => {
    const col = await store.createCollection('C')
    const r = await store.createRequest(col.path, 'A')
    await fsp.writeFile(path.join(dir, r.path), '<<<<<<< HEAD\n')
    await expect(store.saveRequest(r.path, r.request, r.revision)).rejects.toBeInstanceOf(CorruptFileError)
    await expect(store.saveRequest(r.path, r.request, sha('<<<<<<< HEAD\n'))).rejects.toBeInstanceOf(CorruptFileError)
  })

  it('rejects an expected revision that is not a string', async () => {
    const col = await store.createCollection('C')
    const r = await store.createRequest(col.path, 'A')
    await expect(store.saveRequest(r.path, r.request, 5 as unknown as string)).rejects.toThrow('invalid_revision')
  })
})

describe('corrupt files', () => {
  it('reports a conflicted request, loads the rest, and refuses to overwrite it', async () => {
    const col = await store.createCollection('C')
    const good = await store.createRequest(col.path, 'Good')
    const bad = await store.createRequest(col.path, 'Bad')
    const conflict = '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> other\n'
    await fsp.writeFile(path.join(dir, bad.path), conflict)

    const { collections, errors } = await store.list()
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toBe(bad.path)
    expect(names(collections[0].children)).toEqual(['Good'])
    expect(collections[0].children[0].path).toBe(good.path)

    await expect(store.saveRequest(bad.path, bad.request)).rejects.toBeInstanceOf(CorruptFileError)
    expect(await read(bad.path)).toBe(conflict)
  })

  it('reports a corrupt collection.json but still lists its children', async () => {
    const a = await store.createCollection('Alpha')
    await store.createCollection('B')
    await store.createRequest(a.path, 'Zed')
    await store.createRequest(a.path, 'Abe')
    const file = path.join(dir, a.path, 'collection.json')
    await fsp.writeFile(file, '{ nope')
    const { collections, errors } = await store.list()
    expect(errors.map((e) => e.path)).toEqual(['collections/alpha/collection.json'])
    expect(names(collections)).toEqual(['alpha', 'B'])
    expect(collections[0]).toMatchObject({ variables: [], auth: { type: 'none' } })
    expect(names(collections[0].children)).toEqual(['Abe', 'Zed'])
    await expect(store.createRequest(a.path, 'X')).rejects.toBeInstanceOf(CorruptFileError)
    expect(await fsp.readFile(file, 'utf8')).toBe('{ nope')
  })

  it('reports a corrupt folder.json but still lists the folder and its children', async () => {
    const col = await store.createCollection('C')
    const f = await store.createFolder(col.path, 'Fold')
    await store.createRequest(f.path, 'Inside')
    await store.createRequest(col.path, 'Outside')
    const file = path.join(dir, f.path, 'folder.json')
    await fsp.writeFile(file, '<<<<<<< HEAD\n')
    const { collections, errors } = await store.list()
    expect(errors.map((e) => e.path)).toEqual(['collections/c/fold/folder.json'])
    const folder = collections[0].children.find((n) => n.kind === 'folder') as FolderNode
    expect(folder.name).toBe('fold')
    expect(names(folder.children)).toEqual(['Inside'])
    expect(names(collections[0].children)).toContain('Outside')
    await expect(store.createRequest(f.path, 'X')).rejects.toBeInstanceOf(CorruptFileError)
    await expect(store.remove(path.posix.join(f.path, 'inside.request.json'))).rejects.toBeInstanceOf(CorruptFileError)
    expect(await fsp.readFile(file, 'utf8')).toBe('<<<<<<< HEAD\n')
  })

  it('names files by workspace-relative path and never quotes their content in messages', async () => {
    const col = await store.createCollection('C')
    const f = await store.createFolder(col.path, 'F')
    const r = await store.createRequest(col.path, 'R')
    await fsp.writeFile(path.join(dir, r.path), '{"auth": {"token": sk-live-abcdef}}')
    await fsp.writeFile(path.join(dir, f.path, 'folder.json'), '{"id": "x", "name": sk-live-abcdef}')
    await fsp.writeFile(path.join(dir, col.path, 'collection.json'), '{}')
    const { errors } = await store.list()
    expect(errors).toEqual([
      {
        path: 'collections/c/collection.json',
        message: 'Invalid collection metadata in collections/c/collection.json'
      },
      {
        path: 'collections/c/f/folder.json',
        message: 'Invalid JSON in collections/c/f/folder.json (line 1, column 21)'
      },
      { path: r.path, message: `Invalid JSON in ${r.path} (line 1, column 20)` }
    ])
    await expect(store.saveRequest(r.path, r.request)).rejects.toThrow(`Invalid JSON in ${r.path} (line 1, column 20)`)
    await expect(store.createRequest(f.path, 'X')).rejects.toThrow(
      'Invalid JSON in collections/c/f/folder.json (line 1, column 21)'
    )
    await expect(store.rename(r.path, 'Y')).rejects.toThrow(
      'Invalid collection metadata in collections/c/collection.json'
    )
  })

  describe.each([['null'], ['[]'], ['{}']])('malformed JSON %s', (text) => {
    it('is reported per file for collection.json, folder.json and requests without throwing', async () => {
      const col = await store.createCollection('C')
      const f = await store.createFolder(col.path, 'F')
      const r = await store.createRequest(col.path, 'R')
      await store.createRequest(col.path, 'Good')
      const files = [`${col.path}/collection.json`, `${f.path}/folder.json`, r.path]
      for (const file of files) await fsp.writeFile(path.join(dir, file), text)
      const { collections, errors } = await store.list()
      expect(errors.map((e) => e.path).sort()).toEqual([...files].sort())
      expect(names(collections[0].children)).toContain('Good')
      expect(names(collections[0].children)).not.toContain('R')
      expect(collections[0].name).toBe('c')
    })
  })
})

describe('hostile names', () => {
  it.each([['a/b\\c'], ['CON'], ['🚀🔥'], ['x'.repeat(500)], ['é'.repeat(500)], ['𝒜'.repeat(300)]])(
    'creates safe files for %s',
    async (name) => {
      const col = await store.createCollection(name)
      const f = await store.createFolder(col.path, name)
      const r1 = await store.createRequest(col.path, name)
      const r2 = await store.createRequest(col.path, name)
      for (const p of [col.path, f.path, r1.path, r2.path]) {
        expect(p.startsWith('collections/')).toBe(true)
        expect(Buffer.byteLength(path.posix.basename(p))).toBeLessThanOrEqual(255 - 4)
        await fsp.access(path.join(dir, p))
      }
      expect(r1.path).not.toBe(r2.path)
      expect(await fsp.readdir(dir)).toEqual(['collections'])
      expect(await fsp.readdir(path.join(dir, 'collections'))).toHaveLength(1)
    }
  )

  it('keeps the dash that makes a reserved device name safe', async () => {
    const col = await store.createCollection('CON')
    expect(col.path).toBe('collections/con-')
    expect((await store.createRequest(col.path, 'nul')).path).toBe('collections/con-/nul-.request.json')
  })

  it('avoids a hand-made file differing only by case', async () => {
    const col = await store.createCollection('C')
    await fsp.writeFile(path.join(dir, col.path, 'Login.request.json'), '{}')
    const r = await store.createRequest(col.path, 'login')
    expect(r.path).toBe('collections/c/login-2.request.json')
  })
})

describe('invalid targets', () => {
  it('refuses to rename, move or remove metadata files and stray files', async () => {
    const col = await store.createCollection('C')
    const f = await store.createFolder(col.path, 'F')
    await fsp.writeFile(path.join(dir, col.path, 'notes.txt'), 'stray')
    const before = await read('collections/c/collection.json')
    for (const p of [
      'collections/c/collection.json',
      `${f.path}/folder.json`,
      'collections/c/notes.txt',
      'collections/c/missing'
    ]) {
      await expect(store.remove(p)).rejects.toThrow('invalid_target')
      await expect(store.rename(p, 'x')).rejects.toThrow('invalid_target')
      await expect(store.move(p, f.path, 0)).rejects.toThrow('invalid_target')
    }
    expect(await read('collections/c/collection.json')).toBe(before)
    await fsp.access(path.join(dir, 'collections/c/notes.txt'))
    await fsp.access(path.join(dir, f.path, 'folder.json'))
  })
})

describe('escaping paths in rename and move', () => {
  it('rejects escaping sources and destinations', async () => {
    const col = await store.createCollection('C')
    const r = await store.createRequest(col.path, 'A')
    await expect(store.rename('../x.request.json', 'y')).rejects.toThrow('path_outside_workspace')
    await expect(store.move('../x.request.json', col.path, 0)).rejects.toThrow('path_outside_workspace')
    await expect(store.move(r.path, '..', 0)).rejects.toThrow('path_outside_workspace')
    await expect(store.move(r.path, 'collections/../..', 0)).rejects.toThrow('path_outside_workspace')
    await fsp.access(path.join(dir, r.path))
  })
})

describe('remove a collection', () => {
  it('deletes the whole collection directory', async () => {
    const col = await store.createCollection('C')
    await store.createRequest(col.path, 'A')
    await store.remove(col.path)
    expect((await store.list()).collections).toEqual([])
    expect(await fsp.readdir(path.join(dir, 'collections'))).toEqual([])
  })
})

describe('scripts', () => {
  const scripts = { preRequest: 'a', postResponse: 'b' }
  const writeJ = (rel: string, v: unknown) => fsp.writeFile(path.join(dir, rel), JSON.stringify(v))
  const readJ = async (rel: string) => JSON.parse(await read(rel))

  it('lists request, folder and collection scripts as stored', async () => {
    const col = await store.createCollection('C')
    const f = await store.createFolder(col.path, 'F')
    const r = await store.createRequest(f.path, 'R')
    await writeJ(r.path, { ...r.request, scripts })
    await writeJ(`${f.path}/folder.json`, { ...(await readJ(`${f.path}/folder.json`)), scripts })
    await writeJ(`${col.path}/collection.json`, { ...(await readJ(`${col.path}/collection.json`)), scripts })

    const { collections, errors } = await store.list()
    expect(errors).toEqual([])
    expect(collections[0].scripts).toEqual(scripts)
    const folder = collections[0].children[0] as FolderNode
    expect(folder.scripts).toEqual(scripts)
    expect((folder.children[0] as RequestNode).request.scripts).toEqual(scripts)
  })

  it('leaves scripts out where none are stored', async () => {
    const col = await store.createCollection('C')
    await store.createFolder(col.path, 'F')
    const { collections } = await store.list()
    expect(collections[0]).not.toHaveProperty('scripts')
    expect(collections[0].children[0]).not.toHaveProperty('scripts')
  })

  describe.each([
    ['a string', 'x'],
    ['an array', ['a', 'b']],
    ['a missing field', { preRequest: 'a' }],
    ['a non-string field', { preRequest: 'a', postResponse: 1 }]
  ])('scripts as %s', (_label, bad) => {
    it('is a load error for that file only', async () => {
      const col = await store.createCollection('C')
      const f = await store.createFolder(col.path, 'F')
      const r = await store.createRequest(col.path, 'R')
      await store.createRequest(col.path, 'Good')
      await writeJ(r.path, { ...r.request, scripts: bad })
      await writeJ(`${f.path}/folder.json`, { ...(await readJ(`${f.path}/folder.json`)), scripts: bad })
      await writeJ(`${col.path}/collection.json`, { ...(await readJ(`${col.path}/collection.json`)), scripts: bad })
      const { collections, errors } = await store.list()
      expect(errors.map((e) => e.path).sort()).toEqual(
        [`${col.path}/collection.json`, `${f.path}/folder.json`, r.path].sort()
      )
      // Broken metadata falls back to the directory name; the broken request is left out.
      expect(names(collections[0].children)).toEqual(['f', 'Good'])
    })
  })

  it('keeps folder and collection scripts through rename and reorder', async () => {
    const col = await store.createCollection('C')
    const f = await store.createFolder(col.path, 'F')
    await store.createRequest(f.path, 'One')
    const two = await store.createRequest(f.path, 'Two')
    await writeJ(`${f.path}/folder.json`, { ...(await readJ(`${f.path}/folder.json`)), scripts })
    await writeJ(`${col.path}/collection.json`, { ...(await readJ(`${col.path}/collection.json`)), scripts })

    await store.move(two.path, f.path, 0)
    expect((await readJ(`${f.path}/folder.json`)).scripts).toEqual(scripts)
    const fPath = await store.rename(f.path, 'G')
    expect((await readJ(`${fPath}/folder.json`)).scripts).toEqual(scripts)
    await store.move(fPath, col.path, 0)
    expect((await readJ(`${col.path}/collection.json`)).scripts).toEqual(scripts)
    const cPath = await store.rename(col.path, 'D')
    expect((await readJ(`${cPath}/collection.json`)).scripts).toEqual(scripts)
  })
})

describe('importCollection', () => {
  const imported = (over: Partial<ImportedCollection> = {}): ImportedCollection => ({
    name: 'Shop API',
    variables: [{ key: 'base', value: 'https://shop.test', enabled: true }],
    auth: { type: 'bearer', token: '{{token}}' },
    scripts: { preRequest: 'col pre', postResponse: '' },
    children: [
      {
        kind: 'folder',
        name: 'Orders',
        scripts: { preRequest: '', postResponse: 'folder post' },
        children: [
          {
            kind: 'request',
            request: {
              name: 'List orders',
              method: 'GET',
              url: '{{base}}/orders',
              params: [{ key: 'page', value: '1', enabled: true }],
              headers: [],
              body: { mode: 'none' },
              auth: { type: 'inherit' },
              scripts: { preRequest: 'req pre', postResponse: 'req post' }
            }
          }
        ]
      },
      {
        kind: 'request',
        request: {
          name: 'Health',
          method: 'HEAD',
          url: '{{base}}/health',
          params: [],
          headers: [],
          body: { mode: 'none' },
          auth: { type: 'none' }
        }
      }
    ],
    ...over
  })

  const request = (name: string): ImportedNode => ({
    kind: 'request',
    request: {
      name,
      method: 'GET',
      url: '',
      params: [],
      headers: [],
      body: { mode: 'none' },
      auth: { type: 'inherit' }
    }
  })

  const readJsonFile = async (rel: string) => JSON.parse(await read(rel))
  const ids = (nodes: TreeNode[]): string[] =>
    nodes.flatMap((n) => {
      if (n.kind === 'folder') return [n.id, ...ids(n.children)]
      expect(n.request.id).toBe(n.id)
      return [n.id]
    })

  it('writes the whole tree and lists it back as written', async () => {
    const tree = await store.importCollection(imported())
    expect(tree.path).toBe('collections/shop-api')
    expect(tree.name).toBe('Shop API')
    const { collections, errors } = await store.list()
    expect(errors).toEqual([])
    expect(collections).toEqual([tree])

    expect(tree.variables).toEqual([{ key: 'base', value: 'https://shop.test', enabled: true }])
    expect(tree.auth).toEqual({ type: 'bearer', token: '{{token}}' })
    expect(tree.scripts).toEqual({ preRequest: 'col pre', postResponse: '' })
    expect(names(tree.children)).toEqual(['Orders', 'Health'])
    const folder = tree.children[0] as FolderNode
    expect(folder.path).toBe('collections/shop-api/orders')
    expect(folder.scripts).toEqual({ preRequest: '', postResponse: 'folder post' })
    const list = folder.children[0] as RequestNode
    expect(list.path).toBe('collections/shop-api/orders/list-orders.request.json')
    expect(list.request).toMatchObject({
      name: 'List orders',
      url: '{{base}}/orders',
      params: [{ key: 'page', value: '1', enabled: true }],
      scripts: { preRequest: 'req pre', postResponse: 'req post' }
    })
    expect((tree.children[1] as RequestNode).request.method).toBe('HEAD')

    const meta = await readJsonFile('collections/shop-api/collection.json')
    expect(meta).toMatchObject({
      id: tree.id,
      name: 'Shop API',
      order: ['orders', 'health.request.json'],
      variables: tree.variables,
      auth: tree.auth,
      scripts: tree.scripts
    })
    expect(await readJsonFile('collections/shop-api/orders/folder.json')).toEqual({
      id: folder.id,
      name: 'Orders',
      order: ['list-orders.request.json'],
      scripts: { preRequest: '', postResponse: 'folder post' }
    })
  })

  it('gives every item a fresh id', async () => {
    const a = await store.importCollection(imported())
    const b = await store.importCollection(imported())
    const all = [a.id, b.id, ...ids(a.children), ...ids(b.children)]
    expect(new Set(all).size).toBe(all.length)
    for (const id of all) expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('imports the same name twice into two directories, both keeping the name', async () => {
    const a = await store.importCollection(imported())
    const b = await store.importCollection(imported())
    expect([a.path, b.path]).toEqual(['collections/shop-api', 'collections/shop-api-2'])
    expect([a.name, b.name]).toEqual(['Shop API', 'Shop API'])
    expect((await store.list()).collections.map((c) => c.name)).toEqual(['Shop API', 'Shop API'])
  })

  it('makes safe, unique slugs from hostile names and keeps the names', async () => {
    const tree = await store.importCollection(
      imported({
        name: '..',
        children: [request('a/b'), request('..'), request('CON'), request('🙂'), request(''), request('a b')]
      })
    )
    expect(tree.path).toBe('collections/untitled')
    expect(tree.name).toBe('..')
    expect(names(tree.children)).toEqual(['a/b', '..', 'CON', '🙂', 'New Request', 'a b'])
    expect(tree.children.map((n) => path.posix.basename(n.path))).toEqual([
      'a-b.request.json',
      'untitled.request.json',
      'con-.request.json',
      'untitled-2.request.json',
      'new-request.request.json',
      'a-b-2.request.json'
    ])
    expect(await fsp.readdir(path.join(dir, 'collections'))).toEqual(['untitled'])
  })

  it('names empty folders and collections like the importer does', async () => {
    const tree = await store.importCollection(
      imported({ name: '', children: [{ kind: 'folder', name: '', children: [] }] })
    )
    expect(tree.name).toBe('New Collection')
    expect(tree.children[0]).toMatchObject({ name: 'New Folder', path: `${tree.path}/new-folder` })
  })

  it('leaves nothing behind when a write fails', async () => {
    await store.createCollection('Existing')
    const actual = await vi.importActual<typeof import('../../src/main/storage/fsJson')>(
      '../../src/main/storage/fsJson'
    )
    vi.mocked(writeJsonAtomic)
      .mockImplementationOnce(actual.writeJsonAtomic)
      .mockImplementationOnce(actual.writeJsonAtomic)
      .mockRejectedValueOnce(new Error('disk full'))
    await expect(store.importCollection(imported())).rejects.toThrow('disk full')
    expect(await fsp.readdir(path.join(dir, 'collections'))).toEqual(['existing'])
    expect((await store.list()).collections.map((c) => c.name)).toEqual(['Existing'])
    // The store still works afterwards.
    expect((await store.importCollection(imported())).path).toBe('collections/shop-api')
  })

  it('writes into a hidden directory that list() skips', async () => {
    await fsp.mkdir(path.join(dir, 'collections', '.import-leftover'))
    await fsp.writeFile(
      path.join(dir, 'collections', '.import-leftover', 'collection.json'),
      JSON.stringify({ id: 'x', name: 'Half', order: [] })
    )
    const seen: string[] = []
    const actual = await vi.importActual<typeof import('../../src/main/storage/fsJson')>(
      '../../src/main/storage/fsJson'
    )
    vi.mocked(writeJsonAtomic).mockImplementation(async (file, data) => {
      seen.push(path.relative(dir, file).split(path.sep).join('/'))
      return actual.writeJsonAtomic(file, data)
    })
    try {
      await store.importCollection(imported())
    } finally {
      vi.mocked(writeJsonAtomic).mockImplementation(actual.writeJsonAtomic)
    }
    expect(seen.length).toBeGreaterThan(0)
    for (const file of seen) expect(file).toMatch(/^collections\/\.import-[0-9a-f-]{36}\//)
    expect((await store.list()).collections.map((c) => c.name)).toEqual(['Shop API'])
    expect((await fsp.readdir(path.join(dir, 'collections'))).sort()).toEqual(['.import-leftover', 'shop-api'])
  })
})
