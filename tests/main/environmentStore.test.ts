import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { EnvironmentStore, type SecretCipher } from '../../src/main/storage/environmentStore'
import type { Environment } from '../../src/shared/types'

const cipher: SecretCipher = {
  encrypt: (s) => 'enc:' + s,
  decrypt: (s) => {
    if (!s.startsWith('enc:')) throw new Error('bad cipher text')
    return s.slice(4)
  }
}

let dir: string
let store: EnvironmentStore
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'am-env-'))
  store = new EnvironmentStore(dir, cipher)
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

const read = (rel: string) => fsp.readFile(path.join(dir, rel), 'utf8')
const readJ = async (rel: string) => JSON.parse(await read(rel))
const write = async (rel: string, text: string) => {
  await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
  await fsp.writeFile(path.join(dir, rel), text)
}
const exists = (rel: string) =>
  fsp.access(path.join(dir, rel)).then(
    () => true,
    () => false
  )

const env = (over: Partial<Environment> = {}): Environment => ({
  id: 'e1',
  name: 'Staging',
  variables: [],
  ...over
})

async function allFiles(root: string, skip: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name)
    if (p === skip) continue
    if (e.isDirectory()) out.push(...(await allFiles(p, skip)))
    else out.push(p)
  }
  return out
}

describe('storage rule', () => {
  it('writes secrets encrypted to .local and blank to the committed file', async () => {
    await store.save(
      env({
        variables: [
          {
            key: 'token',
            value: 'shared-secret',
            currentValue: 'hunter2',
            secret: true,
            enabled: true
          }
        ]
      })
    )
    expect(await readJ('environments/staging.json')).toEqual({
      id: 'e1',
      name: 'Staging',
      variables: [{ key: 'token', value: '', secret: true, enabled: true }]
    })
    expect(await readJ('.local/environments/staging.json')).toEqual({
      values: { token: 'enc:hunter2' }
    })
    for (const f of await allFiles(dir, path.join(dir, '.local'))) {
      const raw = await fsp.readFile(f, 'utf8')
      expect(raw).not.toContain('hunter2')
      expect(raw).not.toContain('shared-secret')
    }
  })

  it('keeps the shared value of a plain variable committed and its current value local in plain text', async () => {
    await store.save(
      env({
        variables: [
          {
            key: 'host',
            value: 'example.com',
            currentValue: 'localhost',
            secret: false,
            enabled: true
          }
        ]
      })
    )
    expect((await readJ('environments/staging.json')).variables[0]).toEqual({
      key: 'host',
      value: 'example.com',
      secret: false,
      enabled: true
    })
    expect(await readJ('.local/environments/staging.json')).toEqual({
      values: { host: 'localhost' }
    })
  })

  it('creates .local lazily and drops it when no current values remain', async () => {
    await store.save(
      env({
        variables: [{ key: 'a', value: '1', secret: false, enabled: true }]
      })
    )
    expect(await exists('.local')).toBe(false)
    await store.save(
      env({
        variables: [
          {
            key: 'a',
            value: '1',
            currentValue: '2',
            secret: false,
            enabled: true
          }
        ]
      })
    )
    expect(await exists('.local/environments/staging.json')).toBe(true)
    await store.save(
      env({
        variables: [{ key: 'a', value: '1', secret: false, enabled: true }]
      })
    )
    expect(await exists('.local/environments/staging.json')).toBe(false)
  })

  it('stores the globals set as environments/globals.json', async () => {
    await store.save(env({ id: 'globals', name: 'Globals' }))
    expect(await exists('environments/globals.json')).toBe(true)
    await store.save(
      env({
        id: 'globals',
        name: 'Globals',
        variables: [{ key: 'k', value: 'v', secret: false, enabled: true }]
      })
    )
    expect((await store.list()).environments).toHaveLength(1)
  })

  it('does not let a new environment take the globals file name', async () => {
    await store.save(env({ id: 'x', name: 'Globals' }))
    expect(await exists('environments/globals-2.json')).toBe(true)
  })
})

describe('list and resolvedValues', () => {
  const vars: Environment['variables'] = [
    {
      key: 'token',
      value: '',
      currentValue: 'hunter2',
      secret: true,
      enabled: true
    },
    {
      key: 'host',
      value: 'example.com',
      currentValue: 'localhost',
      secret: false,
      enabled: true
    },
    { key: 'port', value: '8080', secret: false, enabled: true },
    { key: 'off', value: 'x', secret: false, enabled: false },
    {
      key: 'empty',
      value: 'fallback',
      currentValue: '',
      secret: false,
      enabled: true
    }
  ]

  it('round-trips what save wrote, including secrets', async () => {
    await store.save(env({ variables: vars }))
    const { environments, errors } = await store.list()
    expect(errors).toEqual([])
    expect(environments).toHaveLength(1)
    expect(environments[0].variables.find((v) => v.key === 'token')).toMatchObject({
      value: '',
      currentValue: 'hunter2',
      secret: true
    })
    expect(environments[0].variables.find((v) => v.key === 'host')).toMatchObject({
      value: 'example.com',
      currentValue: 'localhost'
    })
  })

  it('prefers the current value (an empty one too), falls back to the shared one, skips disabled', async () => {
    await store.save(env({ variables: vars }))
    expect(await store.resolvedValues('e1')).toEqual({
      token: 'hunter2',
      host: 'localhost',
      port: '8080',
      empty: ''
    })
  })

  it('rejects an unknown id', async () => {
    await expect(store.resolvedValues('nope')).rejects.toThrow('environment_not_found')
  })

  it('returns nothing when the directory does not exist', async () => {
    expect(await store.list()).toEqual({ environments: [], errors: [] })
  })
})

describe('damaged files', () => {
  it('reports a corrupt environment file and loads the others', async () => {
    await store.save(env({ id: 'good', name: 'Good' }))
    await write('environments/bad.json', '{ nope')
    const { environments, errors } = await store.list()
    expect(environments.map((e) => e.id)).toEqual(['good'])
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toBe('environments/bad.json')
  })

  it.each([
    ['null', 'null'],
    ['array', '[]'],
    ['empty object', '{}'],
    ['variables not an array', '{"id":"a","name":"A","variables":{}}'],
    ['non-string key', '{"id":"a","name":"A","variables":[{"key":1,"value":"","secret":false,"enabled":true}]}']
  ])('reports a wrongly shaped environment file (%s) without throwing', async (_n, text) => {
    await write('environments/odd.json', text)
    await store.save(env({ id: 'good', name: 'Good' }))
    const { environments, errors } = await store.list()
    expect(environments.map((e) => e.id)).toEqual(['good'])
    expect(errors.map((e) => e.path)).toEqual(['environments/odd.json'])
  })

  it('never overwrites a corrupt globals file', async () => {
    await write('environments/globals.json', '<<<<<<< HEAD\n')
    await expect(store.save(env({ id: 'globals', name: 'Globals' }))).rejects.toThrow()
    expect(await read('environments/globals.json')).toBe('<<<<<<< HEAD\n')
  })

  it.each([['not json'], ['null'], ['[]'], ['{"values":[]}'], ['{"values":{"a":1}}']])(
    'loads the shared values when the .local file is bad (%s) and reports it',
    async (text) => {
      await store.save(
        env({
          variables: [
            {
              key: 'host',
              value: 'example.com',
              currentValue: 'localhost',
              secret: false,
              enabled: true
            },
            {
              key: 'token',
              value: '',
              currentValue: 'hunter2',
              secret: true,
              enabled: true
            }
          ]
        })
      )
      await write('.local/environments/staging.json', text)
      const { environments, errors } = await store.list()
      expect(errors.map((e) => e.path)).toEqual(['.local/environments/staging.json'])
      expect(environments).toHaveLength(1)
      expect(environments[0].variables.map((v) => v.currentValue)).toEqual([undefined, undefined])
      expect(await store.resolvedValues('e1')).toEqual({
        host: 'example.com',
        token: ''
      })
      await expect(store.save(environments[0])).rejects.toThrow()
      expect(await read('.local/environments/staging.json')).toBe(text)
    }
  )

  it('never puts current values of a hand-edited .local file into the error message', async () => {
    await store.save(env({ variables: [{ key: 'host', value: '', currentValue: 'x', secret: false, enabled: true }] }))
    await write('.local/environments/staging.json', '{"values": {"host": sk-live-abcdef123456}}')
    const { errors } = await store.list()
    expect(errors).toEqual([
      {
        path: '.local/environments/staging.json',
        message: 'Invalid JSON in .local/environments/staging.json (line 1, column 21)'
      }
    ])
  })

  it('names files by their workspace-relative path in shape errors', async () => {
    await write('environments/odd.json', '{}')
    await write('.local/environments/odd.json', '{"values":{"a":1}}')
    const { errors } = await store.list()
    expect(errors).toEqual([{ path: 'environments/odd.json', message: 'Invalid environment in environments/odd.json' }])
    await expect(store.save(env({ id: 'globals', name: 'Globals' }))).resolves.toBeUndefined()
    await write('environments/globals.json', '{"id":"other","name":"G","variables":[]}')
    await expect(store.save(env({ id: 'globals', name: 'Globals' }))).rejects.toThrow(
      'Invalid globals environment in environments/globals.json'
    )
  })

  it('reports a secret that fails to decrypt and treats it as empty', async () => {
    await store.save(
      env({
        variables: [
          {
            key: 'token',
            value: '',
            currentValue: 'hunter2',
            secret: true,
            enabled: true
          }
        ]
      })
    )
    await write('.local/environments/staging.json', '{"values":{"token":"garbage"}}')
    const { environments, errors } = await store.list()
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toBe('.local/environments/staging.json')
    expect(environments[0].variables[0].currentValue).toBeUndefined()
    expect(await store.resolvedValues('e1')).toEqual({ token: '' })
  })
})

describe('secrets that cannot be decrypted on this machine', () => {
  const LOCAL = '.local/environments/staging.json'
  const tokenVar = { key: 'token', value: '', currentValue: 'hunter2', secret: true, enabled: true }
  const hostVar = { key: 'host', value: 'example.com', secret: false, enabled: true }

  async function lockedSetup(): Promise<string> {
    await store.save(env({ variables: [tokenVar, hostVar] }))
    // Written by another machine (or before the Keychain was reset): not decryptable here.
    const blob = '{\n  "values": {\n    "token": "foreign-cipher-text"\n  }\n}\n'
    await write(LOCAL, blob)
    return blob
  }

  it('lists such a secret as locked, without a current value', async () => {
    await lockedSetup()
    const { environments } = await store.list()
    expect(environments[0].variables[0]).toEqual({
      key: 'token',
      value: '',
      secret: true,
      enabled: true,
      locked: true
    })
    expect(environments[0].variables[1]).not.toHaveProperty('locked')
  })

  it('keeps the stored blob byte-for-byte when another variable is saved', async () => {
    await lockedSetup()
    const listed = (await store.list()).environments[0]
    await store.save({ ...listed, variables: [listed.variables[0], { ...listed.variables[1], value: 'other.test' }] })
    expect(JSON.parse(await read(LOCAL)).values.token).toBe('foreign-cipher-text')
    expect((await readJ('environments/staging.json')).variables[1].value).toBe('other.test')
    expect(await read('environments/staging.json')).not.toContain('locked')
  })

  it('never deletes the .local file while a retained blob is in it', async () => {
    const blob = await lockedSetup()
    const listed = (await store.list()).environments[0]
    await store.save(listed)
    expect(await read(LOCAL)).toBe(blob)
  })

  it('replaces the blob when a new current value is typed', async () => {
    await lockedSetup()
    const listed = (await store.list()).environments[0]
    await store.save({ ...listed, variables: [{ ...listed.variables[0], currentValue: 'fresh' }, listed.variables[1]] })
    expect(JSON.parse(await read(LOCAL)).values).toEqual({ token: 'enc:fresh' })
    expect((await store.list()).environments[0].variables[0]).toMatchObject({ currentValue: 'fresh' })
    expect((await store.list()).environments[0].variables[0]).not.toHaveProperty('locked')
  })

  it('moves the blob to the new key when a locked secret is renamed', async () => {
    await lockedSetup()
    const listed = (await store.list()).environments[0]
    await store.save({
      ...listed,
      variables: [{ ...listed.variables[0], key: 'apiToken', lockedKey: 'token' }, listed.variables[1]]
    })
    expect(JSON.parse(await read(LOCAL)).values).toEqual({ apiToken: 'foreign-cipher-text' })
    expect(await read('environments/staging.json')).not.toContain('lockedKey')
    expect((await store.list()).environments[0].variables[0]).toMatchObject({ key: 'apiToken', locked: true })
  })

  it('swaps the blobs of two locked secrets whose names were swapped', async () => {
    await store.save(env({ variables: [tokenVar, { ...tokenVar, key: 'other' }] }))
    await write(LOCAL, '{"values":{"token":"blob-a","other":"blob-b"}}')
    const listed = (await store.list()).environments[0]
    await store.save({
      ...listed,
      variables: [
        { ...listed.variables[0], key: 'other', lockedKey: 'token' },
        { ...listed.variables[1], key: 'token', lockedKey: 'other' }
      ]
    })
    expect(JSON.parse(await read(LOCAL)).values).toEqual({ other: 'blob-a', token: 'blob-b' })
  })

  it('removes the blob when the variable is deleted', async () => {
    await lockedSetup()
    const listed = (await store.list()).environments[0]
    await store.save({ ...listed, variables: [listed.variables[1]] })
    expect(await exists(LOCAL)).toBe(false)
  })

  it('does not keep the blob for a variable that is no longer secret or not flagged locked', async () => {
    await lockedSetup()
    const listed = (await store.list()).environments[0]
    await store.save({ ...listed, variables: [{ ...listed.variables[0], secret: false }, listed.variables[1]] })
    expect(await exists(LOCAL)).toBe(false)
    await lockedSetup()
    await store.save(env({ variables: [{ key: 'token', value: '', secret: true, enabled: true }, hostVar] }))
    expect(await exists(LOCAL)).toBe(false)
  })
})

describe('globals file protection', () => {
  it.each([
    ['empty object', '{}'],
    ['array', '[]'],
    ['null', 'null'],
    ['another id', '{"id":"other","name":"O","variables":[]}']
  ])('refuses to overwrite a globals.json that is %s', async (_n, text) => {
    await write('environments/globals.json', text)
    await expect(store.save(env({ id: 'globals', name: 'Globals' }))).rejects.toThrow()
    expect(await read('environments/globals.json')).toBe(text)
  })

  it('gives a user environment named Globals another file and leaves globals.json alone', async () => {
    const text = '{"id":"globals","name":"G","variables":[]}'
    await write('environments/globals.json', text)
    await store.save(env({ id: 'x', name: 'Globals' }))
    expect(await read('environments/globals.json')).toBe(text)
    expect(await exists('environments/globals-2.json')).toBe(true)
  })
})

describe('secret toggles never leak', () => {
  const rawOutsideLocal = async () =>
    (await Promise.all((await allFiles(dir, path.join(dir, '.local'))).map((f) => fsp.readFile(f)))).join('\n')
  const v = (over: Partial<Environment['variables'][number]>): Environment['variables'][number] => ({
    key: 'k',
    value: '',
    secret: false,
    enabled: true,
    ...over
  })

  it('plain variable turned secret: plain text gone everywhere, only the encrypted form remains', async () => {
    await store.save(env({ variables: [v({ value: 'plainshared', currentValue: 'plaincur' })] }))
    await store.save(env({ variables: [v({ value: 'plainshared', currentValue: 'plaincur', secret: true })] }))
    const outside = await rawOutsideLocal()
    expect(outside).not.toContain('plainshared')
    expect(outside).not.toContain('plaincur')
    const local = await read('.local/environments/staging.json')
    expect(JSON.parse(local)).toEqual({ values: { k: 'enc:plaincur' } })
    expect(local).not.toContain('"plaincur"')
  })

  it('secret turned plain: the encrypted blob is gone, the value is a plain current value', async () => {
    await store.save(env({ variables: [v({ currentValue: 'hunter2', secret: true })] }))
    await store.save(env({ variables: [v({ currentValue: 'hunter2', secret: false })] }))
    expect(JSON.parse(await read('.local/environments/staging.json'))).toEqual({ values: { k: 'hunter2' } })
    expect(await read('.local/environments/staging.json')).not.toContain('enc:')
  })

  it('renamed secret key leaves no entry under the old key', async () => {
    await store.save(env({ variables: [v({ key: 'old', currentValue: 'hunter2', secret: true })] }))
    await store.save(env({ variables: [v({ key: 'new', currentValue: 'hunter2', secret: true })] }))
    expect(JSON.parse(await read('.local/environments/staging.json'))).toEqual({ values: { new: 'enc:hunter2' } })
    expect(await rawOutsideLocal()).not.toContain('hunter2')
  })

  it('disabled secret variable stays encrypted and out of the committed file', async () => {
    await store.save(env({ variables: [v({ currentValue: 'hunter2', secret: true, enabled: false })] }))
    expect(JSON.parse(await read('.local/environments/staging.json'))).toEqual({ values: { k: 'enc:hunter2' } })
    expect(await rawOutsideLocal()).not.toContain('hunter2')
    expect((await store.list()).environments[0].variables[0]).toMatchObject({ currentValue: 'hunter2', enabled: false })
  })
})

describe('remove and path safety', () => {
  it('deletes both files', async () => {
    await store.save(
      env({
        variables: [
          {
            key: 'a',
            value: '',
            currentValue: 'b',
            secret: true,
            enabled: true
          }
        ]
      })
    )
    await store.remove('e1')
    expect(await exists('environments/staging.json')).toBe(false)
    expect(await exists('.local/environments/staging.json')).toBe(false)
    expect((await store.list()).environments).toEqual([])
  })

  it('leaves other environments alone and tolerates a missing id', async () => {
    await store.save(env({ id: 'a', name: 'A' }))
    await store.save(env({ id: 'b', name: 'B' }))
    await store.remove('a')
    await store.remove('zzz')
    expect((await store.list()).environments.map((e) => e.id)).toEqual(['b'])
  })

  it.each(['../outside', 'a/b', '..', 'a\\b', ''])('rejects the id %j in remove and save', async (id) => {
    await write('keep.json', '{}')
    await expect(store.remove(id)).rejects.toThrow('invalid_id')
    await expect(store.save(env({ id }))).rejects.toThrow('invalid_id')
    expect(await exists('keep.json')).toBe(true)
  })

  it('keeps file names short and inside environments/', async () => {
    await store.save(env({ name: 'é'.repeat(300) }))
    const files = await fsp.readdir(path.join(dir, 'environments'))
    expect(files).toHaveLength(1)
    expect(Buffer.byteLength(files[0])).toBeLessThan(255 - 10)
    expect(await fsp.readdir(dir)).toEqual(['environments'])
  })

  it('treats names with path characters as plain slugs', async () => {
    await store.save(env({ name: '../../etc/passwd' }))
    expect(await fsp.readdir(path.join(dir, 'environments'))).toEqual(['etc-passwd.json'])
  })

  it('keeps the dash that makes a reserved device name safe', async () => {
    await store.save(env({ name: 'CON' }))
    expect(await fsp.readdir(path.join(dir, 'environments'))).toEqual(['con-.json'])
  })
})

describe('concurrency', () => {
  it('gives parallel saves of same-named new environments distinct files', async () => {
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => store.save(env({ id, name: 'Same' }))))
    const files = (await fsp.readdir(path.join(dir, 'environments'))).sort()
    expect(files).toHaveLength(5)
    expect((await store.list()).environments.map((e) => e.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('keeps the chain alive after a rejected call', async () => {
    const results = await Promise.allSettled([store.save(env({ id: '../x' })), store.save(env({ id: 'ok' }))])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
  })

  it('saving an existing id updates its file in place', async () => {
    await store.save(env())
    await store.save(env({ name: 'Renamed' }))
    expect(await fsp.readdir(path.join(dir, 'environments'))).toEqual(['staging.json'])
    expect((await store.list()).environments[0].name).toBe('Renamed')
  })
})

describe('local flag', () => {
  it('remembers a local variable whose current value equals the initial one', async () => {
    await store.save(
      env({ variables: [{ key: 'h', value: 'x', currentValue: 'x', secret: false, enabled: true, local: true }] })
    )
    expect(await readJ('.local/environments/staging.json')).toEqual({ values: { h: 'x' }, local: ['h'] })
    expect(await readJ('environments/staging.json')).toEqual({
      id: 'e1',
      name: 'Staging',
      variables: [{ key: 'h', value: 'x', secret: false, enabled: true }]
    })
    const { environments, errors } = await store.list()
    expect(errors).toEqual([])
    expect(environments[0].variables).toEqual([
      { key: 'h', value: 'x', currentValue: 'x', secret: false, enabled: true, local: true }
    ])
  })

  it('writes the .local file for a local variable without a current value', async () => {
    await store.save(env({ variables: [{ key: 'h', value: 'x', secret: false, enabled: true, local: true }] }))
    expect(await readJ('.local/environments/staging.json')).toEqual({ values: {}, local: ['h'] })
    const { environments } = await store.list()
    expect(environments[0].variables).toEqual([{ key: 'h', value: 'x', secret: false, enabled: true, local: true }])
  })

  it('ignores local on a secret, which is always local', async () => {
    await store.save(
      env({ variables: [{ key: 't', value: '', currentValue: 's', secret: true, enabled: true, local: true }] })
    )
    expect(await readJ('.local/environments/staging.json')).toEqual({ values: { t: 'enc:s' } })
    const { environments } = await store.list()
    expect(environments[0].variables[0]).not.toHaveProperty('local')
  })

  it('does not mark a variable local when only its current value is stored', async () => {
    await store.save(env({ variables: [{ key: 'h', value: 'x', currentValue: 'y', secret: false, enabled: true }] }))
    expect(await readJ('.local/environments/staging.json')).toEqual({ values: { h: 'y' } })
    const { environments } = await store.list()
    expect(environments[0].variables[0]).not.toHaveProperty('local')
  })

  it('drops the .local file once no variable is local', async () => {
    await store.save(env({ variables: [{ key: 'h', value: 'x', secret: false, enabled: true, local: true }] }))
    await store.save(env({ variables: [{ key: 'h', value: 'x', secret: false, enabled: true }] }))
    expect(await exists('.local/environments/staging.json')).toBe(false)
  })

  it.each([['"h"'], ['[1]'], ['{"h": true}']])('reports a .local file whose local is %s', async (bad) => {
    await store.save(env({ variables: [{ key: 'h', value: 'x', secret: false, enabled: true }] }))
    await write('.local/environments/staging.json', `{"values": {}, "local": ${bad}}`)
    const { environments, errors } = await store.list()
    expect(errors).toEqual([
      { path: '.local/environments/staging.json', message: 'Invalid local values in .local/environments/staging.json' }
    ])
    expect(environments[0].variables).toEqual([{ key: 'h', value: 'x', secret: false, enabled: true }])
  })
})

describe('setCurrentValues', () => {
  it('keeps an empty value a script set instead of falling back to the initial one', async () => {
    await store.save(env({ variables: [{ key: 'a', value: 'init', secret: false, enabled: true }] }))
    await store.setCurrentValues('e1', { set: { a: '' }, unset: [] })
    expect((await readJ('.local/environments/staging.json')).values).toEqual({ a: '' })
    expect(await store.resolvedValues('e1')).toEqual({ a: '' })
    // Saved back from the editor unchanged, it stays empty.
    await store.save((await store.list()).environments[0])
    expect(await store.resolvedValues('e1')).toEqual({ a: '' })
  })

  it('writes current values to .local, encrypting secrets, and leaves the committed file alone', async () => {
    await store.save(
      env({
        variables: [
          { key: 'a', value: 'init', secret: false, enabled: true },
          { key: 's', value: '', currentValue: 'old', secret: true, enabled: true },
          { key: 'keep', value: 'k', currentValue: 'kc', secret: false, enabled: true }
        ]
      })
    )
    const committed = await read('environments/staging.json')
    expect(await store.setCurrentValues('e1', { set: { a: 'now', s: 'new' }, unset: [] })).toBe(true)
    expect(await read('environments/staging.json')).toBe(committed)
    expect((await readJ('.local/environments/staging.json')).values).toEqual({ a: 'now', s: 'enc:new', keep: 'kc' })
  })

  it('adds a missing key with an empty initial value and removes an unset one', async () => {
    await store.save(
      env({
        variables: [
          { key: 'a', value: 'init', currentValue: 'cur', secret: false, enabled: true, local: true },
          { key: 'b', value: 'b', secret: false, enabled: true }
        ]
      })
    )
    await store.setCurrentValues('e1', { set: { fresh: 'x' }, unset: ['a'] })
    expect((await readJ('environments/staging.json')).variables).toEqual([
      { key: 'b', value: 'b', secret: false, enabled: true },
      { key: 'fresh', value: '', secret: false, enabled: true }
    ])
    expect(await readJ('.local/environments/staging.json')).toEqual({ values: { fresh: 'x' } })
  })

  it('keeps a locked secret it does not change', async () => {
    await store.save(env({ variables: [{ key: 's', value: '', secret: true, enabled: true }] }))
    await write('.local/environments/staging.json', JSON.stringify({ values: { s: 'garbage' } }))
    await store.setCurrentValues('e1', { set: { other: '1' }, unset: [] })
    expect((await readJ('.local/environments/staging.json')).values).toEqual({ s: 'garbage', other: '1' })
  })

  it('creates the globals when they were never saved', async () => {
    expect(await store.setCurrentValues('globals', { set: { g: 'v' }, unset: [] })).toBe(true)
    const { environments } = await store.list()
    expect(environments).toEqual([
      {
        id: 'globals',
        name: 'Globals',
        variables: [{ key: 'g', value: '', currentValue: 'v', secret: false, enabled: true }]
      }
    ])
  })

  it('rejects an unknown environment and does nothing for an empty change', async () => {
    await expect(store.setCurrentValues('nope', { set: { a: '1' }, unset: [] })).rejects.toThrow(
      'environment_not_found'
    )
    expect(await store.setCurrentValues('globals', { set: {}, unset: ['x'] })).toBe(false)
    expect(await exists('environments')).toBe(false)
  })
})
