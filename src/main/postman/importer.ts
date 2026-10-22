import type { Auth, EnvVar, HttpMethod, KeyValue, RequestBody, RequestItem, Scripts } from '../../shared/types'
import { decode } from '../../shared/queryCodec'
import { splitQuery } from './url'

export type ImportedNode =
  | { kind: 'folder'; name: string; scripts?: Scripts; children: ImportedNode[] }
  | { kind: 'request'; request: Omit<RequestItem, 'id'> }

export interface ImportedCollection {
  name: string
  variables: KeyValue[]
  auth: Auth
  scripts?: Scripts
  children: ImportedNode[]
}

export interface ImportedEnvironment {
  name: string
  scope: 'environment' | 'globals'
  variables: EnvVar[]
}

export type Parsed =
  | { kind: 'collection'; collection: ImportedCollection; warnings: string[] }
  | { kind: 'environment'; environment: ImportedEnvironment; warnings: string[] }

const NOT_POSTMAN = 'Not a Postman collection or environment file'
const V1 = 'Postman Collection v1 is not supported. Export it from Postman as Collection v2.1 and import that file.'
const DUMP = 'This is a Postman data dump. Export the collections and environments one by one and import those files.'

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const RAW_LANGUAGES = ['json', 'xml', 'html', 'text'] as const

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Postman stores most scalars as strings, but numbers, booleans and null show up too. */
function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function objects(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : []
}

function nameOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** A description is a string or `{ content }`; empty ones are left out. */
function descriptionOf(value: unknown): string | undefined {
  const text = isObject(value) ? value.content : value
  return typeof text === 'string' && text !== '' ? text : undefined
}

function keyValue(entry: Json): KeyValue {
  const description = descriptionOf(entry.description)
  const kv: KeyValue = { key: str(entry.key), value: str(entry.value), enabled: entry.disabled !== true }
  return description === undefined ? kv : { ...kv, description }
}

/** Parses the text of a Postman collection, environment or globals file. Throws with a message for the user. */
export function parsePostman(text: string): Parsed {
  let data: unknown
  try {
    data = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text)
  } catch (err) {
    throw new Error(`Not valid JSON: ${(err as Error).message}`)
  }
  if (!isObject(data)) throw new Error(NOT_POSTMAN)
  if (data.version !== undefined && Array.isArray(data.collections)) throw new Error(DUMP)
  if (Array.isArray(data.requests) && data.info === undefined) throw new Error(V1)
  if (isCollection(data)) {
    const warnings: string[] = []
    return { kind: 'collection', collection: new CollectionImporter(warnings).collection(data), warnings }
  }
  if (Array.isArray(data.values) && typeof data.name === 'string') {
    return { kind: 'environment', environment: environment(data), warnings: [] }
  }
  throw new Error(NOT_POSTMAN)
}

/**
 * Converts one Postman request (`{ url, method, header, body, auth }`, or a plain URL string meaning a GET), as
 * `pm.sendRequest` receives it. `header` may also be an object of name to value. Without `auth` the request inherits.
 */
export function fromPostmanRequest(
  raw: unknown,
  name: string,
): { request: Omit<RequestItem, 'id'>; warnings: string[] } {
  const warnings: string[] = []
  let source: unknown = raw
  if (isObject(raw) && isObject(raw.header)) {
    const header = Object.entries(raw.header).map(([key, value]) => ({ key, value }))
    source = { ...raw, header }
  }
  const node = new CollectionImporter(warnings).requestItem({ name, request: source }, undefined)
  return { request: node.request, warnings }
}

function isCollection(data: Json): boolean {
  if (!isObject(data.info)) return false
  const schema = data.info.schema
  if (typeof schema === 'string' && (schema.includes('v2.1') || schema.includes('v2.0'))) return true
  return Array.isArray(data.item)
}

function environment(data: Json): ImportedEnvironment {
  const variables = objects(data.values).map((entry): EnvVar => {
    const key = str(entry.key)
    const value = str(entry.value)
    const enabled = entry.enabled !== false
    if (entry.type === 'secret') {
      return value === ''
        ? { key, value: '', secret: true, enabled }
        : { key, value: '', currentValue: value, secret: true, enabled }
    }
    return { key, value, secret: false, enabled }
  })
  return {
    name: data.name as string,
    scope: data._postman_variable_scope === 'globals' ? 'globals' : 'environment',
    variables,
  }
}

/** Joins the enabled `prerequest` and `test` events; undefined when both scripts are empty. */
function scriptsOf(events: unknown): Scripts | undefined {
  const pre: string[] = []
  const post: string[] = []
  for (const event of objects(events)) {
    if (event.disabled === true) continue
    const exec = isObject(event.script) ? event.script.exec : undefined
    const source = Array.isArray(exec) ? exec.map(str).join('\n') : typeof exec === 'string' ? exec : ''
    if (source === '') continue
    if (event.listen === 'prerequest') pre.push(source)
    else if (event.listen === 'test') post.push(source)
  }
  if (pre.length === 0 && post.length === 0) return undefined
  return { preRequest: pre.join('\n'), postResponse: post.join('\n') }
}

/** Rebuilds a raw URL from the parts of a Postman URL object that has no `raw`. */
function rebuildUrl(url: Json): string {
  const part = (p: unknown) => (isObject(p) ? str(p.value) : str(p))
  const host = Array.isArray(url.host) ? url.host.map(part).join('.') : str(url.host)
  const path = Array.isArray(url.path) ? url.path.map(part).join('/') : str(url.path).replace(/^\//, '')
  const protocol = url.protocol ? `${str(url.protocol)}://` : ''
  const port = url.port ? `:${str(url.port)}` : ''
  return `${protocol}${host}${port}${path === '' ? '' : `/${path}`}`
}

class CollectionImporter {
  private examples = 0

  constructor(private readonly warnings: string[]) {}

  collection(data: Json): ImportedCollection {
    const info = data.info as Json
    const name = nameOf(info.name, 'New Collection')
    const auth = data.auth === undefined || data.auth === null ? undefined : this.auth(data.auth, name)
    const collection: ImportedCollection = {
      name,
      variables: objects(data.variable).map((v) => ({
        key: str(v.key ?? v.id),
        value: str(v.value),
        enabled: v.disabled !== true,
      })),
      auth: auth === undefined || auth.type === 'inherit' ? { type: 'none' } : auth,
      children: this.items(data.item, undefined),
    }
    const scripts = scriptsOf(data.event)
    if (scripts) collection.scripts = scripts
    if (this.examples > 0) {
      this.warnings.push(
        this.examples === 1
          ? '1 saved example response was not imported'
          : `${this.examples} saved example responses were not imported`,
      )
    }
    return collection
  }

  /** `inherited` is the nearest folder auth above these items; undefined means the collection's. */
  private items(items: unknown, inherited: Auth | undefined): ImportedNode[] {
    return objects(items).map((item) =>
      Array.isArray(item.item) ? this.folder(item, inherited) : this.requestItem(item, inherited),
    )
  }

  private folder(item: Json, inherited: Auth | undefined): ImportedNode {
    const name = nameOf(item.name, 'New Folder')
    const own = item.auth === undefined || item.auth === null ? undefined : this.auth(item.auth, name)
    const auth = own === undefined || own.type === 'inherit' ? inherited : own
    const folder: ImportedNode = { kind: 'folder', name, children: this.items(item.item, auth) }
    const scripts = scriptsOf(item.event)
    if (scripts) folder.scripts = scripts
    return folder
  }

  requestItem(item: Json, inherited: Auth | undefined): ImportedNode & { kind: 'request' } {
    const name = nameOf(item.name, 'New Request')
    if (Array.isArray(item.response)) this.examples += item.response.length
    const source: Json =
      typeof item.request === 'string' ? { url: item.request } : isObject(item.request) ? item.request : {}

    // Converted in field order, so the warnings of one request come in that order too.
    const method = this.method(source.method, name)
    const { url, params } = this.url(source.url, name)
    const headers = objects(source.header).map(keyValue)
    const body = this.body(source.body, name)
    const own: Auth =
      source.auth === undefined || source.auth === null ? { type: 'inherit' } : this.auth(source.auth, name)
    const auth = own.type === 'inherit' && inherited !== undefined ? { ...inherited } : own
    const request: Omit<RequestItem, 'id'> = { name, method, url, params, headers, body, auth }
    const scripts = scriptsOf(item.event)
    if (scripts) request.scripts = scripts
    return { kind: 'request', request }
  }

  private method(value: unknown, name: string): HttpMethod {
    if (typeof value !== 'string' || value === '') return 'GET'
    const method = value.toUpperCase()
    if ((METHODS as readonly string[]).includes(method)) return method as HttpMethod
    this.warnings.push(`"${name}": method ${method} is not supported, imported as GET`)
    return 'GET'
  }

  /** Params are stored decoded, like the URL bar does; `{{variables}}` and malformed escapes stay as written. */
  private url(value: unknown, name: string): { url: string; params: KeyValue[] } {
    const decoded = (params: KeyValue[]) => params.map((p) => ({ ...p, key: decode(p.key), value: decode(p.value) }))
    if (typeof value === 'string') {
      const split = splitQuery(value)
      return { url: split.url, params: decoded(split.params) }
    }
    if (!isObject(value)) return { url: '', params: [] }
    if (Array.isArray(value.variable) && value.variable.length > 0) {
      this.warnings.push(`"${name}": path variables are not supported; :name segments are left in the URL`)
    }
    const split = splitQuery(typeof value.raw === 'string' ? value.raw : rebuildUrl(value))
    const params = Array.isArray(value.query) ? objects(value.query).map(keyValue) : split.params
    return { url: split.url, params: decoded(params) }
  }

  private body(value: unknown, name: string): RequestBody {
    if (!isObject(value) || value.mode === undefined || value.mode === null) return { mode: 'none' }
    switch (value.mode) {
      case 'raw': {
        const options = isObject(value.options) && isObject(value.options.raw) ? value.options.raw : {}
        const language = RAW_LANGUAGES.find((l) => l === options.language) ?? 'text'
        return { mode: 'raw', language, content: str(value.raw) }
      }
      case 'urlencoded':
        return { mode: 'urlencoded', fields: objects(value.urlencoded).map(keyValue) }
      case 'formdata': {
        const fields: KeyValue[] = []
        for (const field of objects(value.formdata)) {
          if (field.type === 'file') this.warnings.push(`"${name}": file field "${str(field.key)}" was skipped`)
          else fields.push(keyValue(field))
        }
        return { mode: 'formdata', fields }
      }
      case 'graphql': {
        const graphql = isObject(value.graphql) ? value.graphql : {}
        this.warnings.push(`"${name}": GraphQL body imported as JSON`)
        return {
          mode: 'raw',
          language: 'json',
          content: JSON.stringify(
            { query: str(graphql.query), variables: graphqlVariables(graphql.variables) },
            null,
            2,
          ),
        }
      }
      default:
        this.warnings.push(`"${name}": ${str(value.mode)} body is not supported`)
        return { mode: 'none' }
    }
  }

  /** Converts a Postman auth object; `owner` names the item in warnings. */
  private auth(value: unknown, owner: string): Auth {
    if (!isObject(value)) return { type: 'none' }
    const type = str(value.type)
    const params = value[type]
    /** v2.1 stores `[{ key, value }]`, v2.0 a plain object. */
    const param = (key: string): string => {
      if (Array.isArray(params)) return str(objects(params).find((p) => p.key === key)?.value)
      return isObject(params) ? str(params[key]) : ''
    }
    switch (type) {
      case 'inherit':
        return { type: 'inherit' }
      case 'noauth':
        return { type: 'none' }
      case 'bearer':
        return { type: 'bearer', token: param('token') }
      case 'basic':
        return { type: 'basic', username: param('username'), password: param('password') }
      case 'apikey':
        return {
          type: 'apikey',
          key: param('key'),
          value: param('value'),
          in: param('in') === 'query' ? 'query' : 'header',
        }
      default:
        this.warnings.push(`"${owner}": ${type} auth is not supported, imported as No Auth`)
        return { type: 'none' }
    }
  }
}

/** GraphQL variables are usually a JSON string; parse it when it is valid JSON, drop it when empty. */
function graphqlVariables(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? undefined
  if (value.trim() === '') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
