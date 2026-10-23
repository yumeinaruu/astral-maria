import { encode } from '../../shared/queryCodec'
import type { KeyValue, RequestItem, SnippetLanguage } from '../../shared/types'
import { applyAuth, buildUrl, RAW_CONTENT_TYPES, setHeader, type Headers } from './dispatchOptions'

// Code that sends a resolved request the way Send does: the same URL and query, headers, auth and body. Two things
// differ on purpose: Accept-Encoding is left to the tool (curl would print compressed bytes), and a form-data body is
// built by the tool, which picks its own boundary.

type SpecBody =
  | { kind: 'none' }
  | { kind: 'raw'; text: string }
  | { kind: 'urlencoded'; fields: [string, string][] }
  | { kind: 'formdata'; fields: [string, string][] }

interface Spec {
  method: string
  url: string
  headers: [string, string][]
  body: SpecBody
}

const pairs = (rows: KeyValue[]): [string, string][] =>
  rows.filter((r) => r.enabled && r.key !== '').map((r) => [r.key, r.value])

/** The URL as sent; for one that is not a valid URL (an unknown `{{variable}}`), the text with the query appended. */
function snippetUrl(request: RequestItem): string {
  try {
    return buildUrl(request).toString()
  } catch {
    const query = pairs(request.params).map(([k, v]) => `${encode(k)}=${encode(v)}`)
    if (request.auth.type === 'apikey' && request.auth.in === 'query' && request.auth.key !== '') {
      query.push(`${encode(request.auth.key)}=${encode(request.auth.value)}`)
    }
    if (query.length === 0) return request.url
    return `${request.url}${request.url.includes('?') ? '&' : '?'}${query.join('&')}`
  }
}

function toSpec(request: RequestItem): Spec {
  const headers: Headers = new Map()
  for (const [k, v] of pairs(request.headers)) setHeader(headers, k, v)
  applyAuth(request, headers)
  const defaultType = (type: string) => {
    if (!headers.has('content-type')) setHeader(headers, 'Content-Type', type)
  }
  let body: SpecBody = { kind: 'none' }
  const b = request.body
  if (request.method !== 'HEAD') {
    if (b.mode === 'raw') {
      defaultType(RAW_CONTENT_TYPES[b.language])
      body = { kind: 'raw', text: b.content }
    } else if (b.mode === 'urlencoded') {
      defaultType('application/x-www-form-urlencoded')
      body = { kind: 'urlencoded', fields: pairs(b.fields) }
    } else if (b.mode === 'formdata') {
      headers.delete('content-type')
      body = { kind: 'formdata', fields: pairs(b.fields) }
    }
  }
  return {
    method: request.method,
    url: snippetUrl(request),
    headers: [...headers.values()].map((h) => [h.name, h.value]),
    body,
  }
}

/** A POSIX shell single-quoted word. */
function sh(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function curl(spec: Spec): string {
  const head = ['curl', '--location']
  if (spec.method === 'HEAD') head.push('--head')
  else if (spec.method !== 'GET' || spec.body.kind !== 'none') head.push('--request', spec.method)
  head.push(sh(spec.url))
  const lines = [head.join(' ')]
  for (const [k, v] of spec.headers) lines.push(`--header ${sh(`${k}: ${v}`)}`)
  const body = spec.body
  if (body.kind === 'raw') lines.push(`--data-raw ${sh(body.text)}`)
  else if (body.kind === 'urlencoded') {
    // curl encodes the value of `name=value`, not the name.
    for (const [k, v] of body.fields) lines.push(`--data-urlencode ${sh(`${encodeURIComponent(k)}=${v}`)}`)
  } else if (body.kind === 'formdata') {
    // --form-string, not --form: a value starting with @ or < stays text.
    for (const [k, v] of body.fields) lines.push(`--form-string ${sh(`${k}=${v}`)}`)
  }
  return lines.join(' \\\n  ') + '\n'
}

/** A JavaScript (and Python) string literal. */
const str = (text: string): string => JSON.stringify(text)

function fetchJs(spec: Spec): string {
  const out: string[] = []
  const body = spec.body
  if (body.kind === 'formdata') {
    out.push('const form = new FormData()')
    for (const [k, v] of body.fields) out.push(`form.append(${str(k)}, ${str(v)})`)
    out.push('')
  }
  const options: string[] = []
  if (spec.method !== 'GET') options.push(`  method: ${str(spec.method)},`)
  if (spec.headers.length > 0) {
    options.push('  headers: {')
    for (const [k, v] of spec.headers) options.push(`    ${str(k)}: ${str(v)},`)
    options.push('  },')
  }
  if (body.kind === 'raw') options.push(`  body: ${str(body.text)},`)
  else if (body.kind === 'urlencoded') {
    const fields = body.fields.map(([k, v]) => `[${str(k)}, ${str(v)}]`).join(', ')
    options.push(`  body: new URLSearchParams([${fields}]),`)
  } else if (body.kind === 'formdata') options.push('  body: form,')
  // Like Send, redirects are followed (fetch's default).
  out.push(
    options.length > 0
      ? `const response = await fetch(${str(spec.url)}, {\n${options.join('\n')}\n})`
      : `const response = await fetch(${str(spec.url)})`,
  )
  out.push('console.log(response.status, await response.text())')
  return out.join('\n') + '\n'
}

function python(spec: Spec): string {
  const out = ['import requests', '', `url = ${str(spec.url)}`]
  const args = ['url']
  if (spec.headers.length > 0) {
    out.push('headers = {')
    for (const [k, v] of spec.headers) out.push(`    ${str(k)}: ${str(v)},`)
    out.push('}')
    args.push('headers=headers')
  }
  const body = spec.body
  const tuples = (fields: [string, string][], wrap: (v: string) => string) =>
    ['[', ...fields.map(([k, v]) => `    (${str(k)}, ${wrap(v)}),`), ']'].join('\n')
  if (body.kind === 'raw') {
    out.push(`payload = ${str(body.text)}`)
    args.push('data=payload.encode("utf-8")')
  } else if (body.kind === 'urlencoded') {
    out.push(`payload = ${tuples(body.fields, str)}`)
    args.push('data=payload')
  } else if (body.kind === 'formdata') {
    // (None, value) makes requests send a plain multipart field rather than a file.
    out.push(`files = ${tuples(body.fields, (v) => `(None, ${str(v)})`)}`)
    args.push('files=files')
  }
  // requests does not follow redirects for HEAD by default; Send does.
  if (spec.method === 'HEAD') args.push('allow_redirects=True')
  out.push(
    '',
    `response = requests.request(${str(spec.method)}, ${args.join(', ')})`,
    '',
    'print(response.status_code)',
    'print(response.text)',
  )
  return out.join('\n') + '\n'
}

const GENERATORS: Record<SnippetLanguage, (spec: Spec) => string> = { curl, fetch: fetchJs, python }

export const SNIPPET_LANGUAGES = Object.keys(GENERATORS) as SnippetLanguage[]

/** Code in `language` that sends `request` (resolved: variables substituted, inherited auth applied). */
export function snippet(request: RequestItem, language: SnippetLanguage): string {
  if (!Object.hasOwn(GENERATORS, language)) throw new Error(`unknown_language: ${String(language)}`)
  return GENERATORS[language](toSpec(request))
}
