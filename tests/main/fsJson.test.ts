import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CorruptFileError, readJson, resolveInside, writeJsonAtomic } from '../../src/main/storage/fsJson'

let dir: string
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'am-fsjson-'))
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('writeJsonAtomic', () => {
  it('writes 2-space indented JSON with trailing newline', async () => {
    const p = path.join(dir, 'a.json')
    await writeJsonAtomic(p, { a: 1, b: [2] })
    expect(await fsp.readFile(p, 'utf8')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n')
  })

  it('leaves the target intact and no temp file when rename fails', async () => {
    // Renaming a file onto a non-empty directory fails, simulating a failed rename.
    const target = path.join(dir, 'target')
    await fsp.mkdir(target)
    await fsp.writeFile(path.join(target, 'keep.txt'), 'keep')
    await expect(writeJsonAtomic(target, { v: 2 })).rejects.toThrow()
    expect(await fsp.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('keep')
    expect(await fsp.readdir(dir)).toEqual(['target'])
  })
})

describe('readJson', () => {
  it('parses valid JSON', async () => {
    const p = path.join(dir, 'ok.json')
    await fsp.writeFile(p, '{"a":1}')
    expect(await readJson(p)).toEqual({ a: 1 })
  })

  it('rejects invalid JSON with CorruptFileError', async () => {
    const p = path.join(dir, 'bad.json')
    await fsp.writeFile(p, '{"a":')
    const err = (await readJson(p).catch((e: unknown) => e)) as CorruptFileError
    expect(err).toBeInstanceOf(CorruptFileError)
    expect(err.path).toBe(p)
  })

  it('rejects conflict markers with a specific message', async () => {
    const p = path.join(dir, 'conflict.json')
    await fsp.writeFile(p, '{\n<<<<<<< HEAD\n"a": 1\n=======\n"a": 2\n>>>>>>> x\n}\n')
    const err = (await readJson(p).catch((e: unknown) => e)) as CorruptFileError
    expect(err).toBeInstanceOf(CorruptFileError)
    expect(err.path).toBe(p)
    expect(err.message).toMatch(/conflict/i)
  })

  it('lets ENOENT through', async () => {
    await expect(readJson(path.join(dir, 'missing.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('resolveInside', () => {
  it('resolves inside paths', () => {
    expect(resolveInside('/w', 'a/b')).toBe(path.resolve('/w/a/b'))
    expect(resolveInside('/w', 'a\\b')).toBe(path.resolve('/w/a/b'))
  })

  it('rejects escapes', () => {
    for (const rel of ['../x', 'a/../../x', 'a\\..\\..\\x', '/etc/passwd', '..']) {
      expect(() => resolveInside('/w', rel)).toThrow('path_outside_workspace')
    }
  })

  it('rejects sibling directories sharing a prefix', () => {
    expect(() => resolveInside('/w', '../w2/x')).toThrow('path_outside_workspace')
  })
})
