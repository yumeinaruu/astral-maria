import type {
  Auth,
  CollectionTree,
  Environment,
  KeyValue,
  RequestBody,
  RequestItem,
  Scripts,
  TreeNode,
} from '../../shared/types'
import { toPostmanUrl } from './url'

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'

const SUFFIXES = {
  collection: '.postman_collection.json',
  environment: '.postman_environment.json',
  globals: '.postman_globals.json',
} as const

/** Characters Windows, macOS or Linux refuse in a file name, plus control characters. */
const ILLEGAL_IN_FILE_NAME = /[<>:"/\\|?*\u0000-\u001f]/g

type Json = Record<string, unknown>

/** Writes a collection tree as a Postman Collection v2.1 object. */
export function toPostmanCollection(tree: CollectionTree): Json {
  const collection: Json = {
    info: { _postman_id: tree.id, name: tree.name, schema: SCHEMA },
    item: tree.children.map(item),
  }
  if (tree.variables.length > 0) collection.variable = tree.variables.map(keyValue)
  const auth = authOf(tree.auth)
  if (auth !== undefined && tree.auth.type !== 'none') collection.auth = auth
  const events = eventsOf(tree.scripts)
  if (events.length > 0) collection.event = events
  return collection
}

/** Writes an environment (or the globals) in Postman's environment format; secrets are written empty. */
export function toPostmanEnvironment(env: Environment): Json {
  return {
    id: env.id,
    name: env.name,
    values: env.variables.map((v) => ({
      key: v.key,
      value: v.secret ? '' : v.value,
      type: v.secret ? 'secret' : 'default',
      enabled: v.enabled,
    })),
    _postman_variable_scope: env.id === 'globals' ? 'globals' : 'environment',
  }
}

/**
 * `<name>.postman_collection.json` etc., with characters illegal in file names replaced by `_` and trailing dots and
 * spaces (which Windows drops) trimmed; `Untitled` when nothing but whitespace and illegal characters is left.
 */
export function exportFileName(name: string, kind: 'collection' | 'environment' | 'globals'): string {
  const stem = name.replace(ILLEGAL_IN_FILE_NAME, '_').replace(/[. ]+$/, '')
  const meaningful = name.replace(ILLEGAL_IN_FILE_NAME, '').trim() !== '' && stem !== ''
  return `${meaningful ? stem : 'Untitled'}${SUFFIXES[kind]}`
}

function item(node: TreeNode): Json {
  if (node.kind === 'folder') {
    const folder: Json = { name: node.name, item: node.children.map(item) }
    const events = eventsOf(node.scripts)
    if (events.length > 0) folder.event = events
    return folder
  }
  const result: Json = { name: node.name, request: request(node.request) }
  const events = eventsOf(node.request.scripts)
  if (events.length > 0) result.event = events
  return result
}

function request(r: RequestItem): Json {
  const result: Json = { method: r.method, header: r.headers.map(keyValue) }
  const body = bodyOf(r.body)
  if (body !== undefined) result.body = body
  result.url = toPostmanUrl(r.url, r.params)
  const auth = authOf(r.auth)
  if (auth !== undefined) result.auth = auth
  return result
}

/** `disabled` and `description` are only written when they say something. */
function keyValue(kv: KeyValue): Json {
  return {
    key: kv.key,
    value: kv.value,
    ...(kv.enabled ? {} : { disabled: true }),
    ...(kv.description === undefined ? {} : { description: kv.description }),
  }
}

function bodyOf(body: RequestBody): Json | undefined {
  switch (body.mode) {
    case 'none':
      return undefined
    case 'raw':
      return { mode: 'raw', raw: body.content, options: { raw: { language: body.language } } }
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: body.fields.map(keyValue) }
    case 'formdata':
      return {
        mode: 'formdata',
        formdata: body.fields.map((f) => {
          const { key, value, ...rest } = keyValue(f)
          return { key, value, type: 'text', ...rest }
        }),
      }
  }
}

/** Undefined for `inherit`, which Postman expresses by leaving `auth` out. */
function authOf(auth: Auth): Json | undefined {
  const params = (entries: [string, string][]) => entries.map(([key, value]) => ({ key, value, type: 'string' }))
  switch (auth.type) {
    case 'inherit':
      return undefined
    case 'none':
      return { type: 'noauth' }
    case 'bearer':
      return { type: 'bearer', bearer: params([['token', auth.token]]) }
    case 'basic':
      return {
        type: 'basic',
        basic: params([
          ['username', auth.username],
          ['password', auth.password],
        ]),
      }
    case 'apikey':
      return {
        type: 'apikey',
        apikey: params([
          ['key', auth.key],
          ['value', auth.value],
          ['in', auth.in],
        ]),
      }
  }
}

/** One event per non-empty script; `exec` holds the script's lines. */
function eventsOf(scripts: Scripts | undefined): Json[] {
  if (!scripts) return []
  const events: Json[] = []
  const add = (listen: string, source: string) => {
    if (source !== '') events.push({ listen, script: { type: 'text/javascript', exec: source.split('\n') } })
  }
  add('prerequest', scripts.preRequest)
  add('test', scripts.postResponse)
  return events
}
