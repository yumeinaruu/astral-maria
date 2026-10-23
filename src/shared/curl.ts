import { decode } from './queryCodec'
import type { Auth, HttpMethod, KeyValue, RequestBody } from './types'

/** What a pasted `curl` command describes; `url` still carries its query string. */
export interface ParsedCurl {
  method: HttpMethod
  url: string
  headers: KeyValue[]
  body: RequestBody
  auth: Auth
  /** Parts of the command that were left out, e.g. a file upload; for a notice. */
  skipped: string[]
}

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/** True when `text` reads as a curl command (after leading whitespace and an optional `$ ` prompt). */
export function looksLikeCurl(text: string): boolean {
  return /^\s*(?:\$\s+)?curl(?:\.exe)?\s/i.test(text)
}

const ANSI_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' }

/**
 * Splits a POSIX shell command line into words: single quotes, double quotes (with `\` escapes), `$'…'` ANSI-C
 * quotes, backslash escapes and backslash-newline continuations. Also accepts the `^` continuations of Windows cmd at
 * line ends. Throws on an unterminated quote.
 */
export function shellWords(text: string): string[] {
  const words: string[] = []
  const src = text.replace(/\^\r?\n/g, ' ')
  let word: string | null = null
  const add = (s: string) => {
    word = (word ?? '') + s
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      const next = src[i + 1]
      if (next === '\n') i += 2
      else if (next === '\r' && src[i + 2] === '\n') i += 3
      else {
        if (next !== undefined) add(next)
        i += 2
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) throw new Error('Unterminated quote')
      add(src.slice(i + 1, end))
      i = end + 1
    } else if (c === '$' && src[i + 1] === "'") {
      let s = ''
      i += 2
      for (; i < src.length && src[i] !== "'"; i++) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const e = src[++i]
          if (e === 'x' && /^[0-9a-fA-F]{1,2}/.test(src.slice(i + 1))) {
            const hex = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 1))![0]
            s += String.fromCharCode(parseInt(hex, 16))
            i += hex.length
          } else s += ANSI_ESCAPES[e] ?? `\\${e}`
        } else s += src[i]
      }
      if (i >= src.length) throw new Error('Unterminated quote')
      add(s)
      i++
    } else if (c === '"') {
      let s = ''
      i++
      for (; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '\\' && '"\\$`\n'.includes(src[i + 1] ?? '')) {
          if (src[i + 1] !== '\n') s += src[i + 1]
          i++
        } else s += src[i]
      }
      if (i >= src.length) throw new Error('Unterminated quote')
      add(s)
      i++
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word)
      word = null
      i++
    } else {
      add(c)
      i++
    }
  }
  if (word !== null) words.push(word)
  return words
}

/** Long options that take a value, by canonical name. */
const LONG_WITH_VALUE: Record<string, string> = {
  request: 'X',
  header: 'H',
  data: 'd',
  'data-raw': 'data-raw',
  'data-ascii': 'd',
  'data-binary': 'data-binary',
  'data-urlencode': 'data-urlencode',
  json: 'json',
  form: 'F',
  'form-string': 'form-string',
  user: 'u',
  url: 'url',
  cookie: 'b',
  'user-agent': 'A',
  referer: 'e',
}

/** Options that take a value and do not change the request; their value is skipped. */
const IGNORED_WITH_VALUE = new Set([
  'o',
  'output',
  'm',
  'max-time',
  'connect-timeout',
  'retry',
  'retry-delay',
  'retry-max-time',
  'w',
  'write-out',
  'x',
  'proxy',
  'U',
  'proxy-user',
  'cert',
  'E',
  'key',
  'cacert',
  'capath',
  'c',
  'cookie-jar',
  'max-redirs',
  'limit-rate',
  'interface',
  'resolve',
  'connect-to',
  'K',
  'config',
  'D',
  'dump-header',
  'trace',
  'trace-ascii',
  'ciphers',
  'Y',
  'speed-limit',
  'y',
  'speed-time',
  'max-filesize',
  'expect100-timeout',
  'unix-socket',
])

/** Short options that take a value (the rest are flags). */
const SHORT_WITH_VALUE = new Set([
  'X',
  'H',
  'd',
  'F',
  'u',
  'b',
  'A',
  'e',
  'o',
  'm',
  'w',
  'x',
  'U',
  'E',
  'c',
  'K',
  'D',
  'Y',
  'y',
])

type DataPart = { kind: 'raw' | 'binary' | 'urlencode'; value: string }

/** `name=content` of --data-urlencode: the content is encoded, the name is not (curl's rules, minus `@file`). */
function urlencodePart(value: string): string {
  const eq = value.indexOf('=')
  if (eq < 0) return encodeURIComponent(value)
  if (eq === 0) return encodeURIComponent(value.slice(1))
  return `${value.slice(0, eq)}=${encodeURIComponent(value.slice(eq + 1))}`
}

function header(text: string): KeyValue | null {
  const colon = text.indexOf(':')
  if (colon <= 0) return null
  const key = text.slice(0, colon).trim()
  return { key, value: text.slice(colon + 1).trim(), enabled: true }
}

/** The fields of `a=1&b=2` when every part is a `key=value` pair; else null. */
function formPairs(text: string): KeyValue[] | null {
  if (text === '') return null
  const fields: KeyValue[] = []
  for (const part of text.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0 || /[\s{}[\]"]/.test(part.slice(0, eq))) return null
    const plus = (s: string) => s.replace(/\+/g, ' ')
    fields.push({ key: decode(plus(part.slice(0, eq))), value: decode(plus(part.slice(eq + 1))), enabled: true })
  }
  return fields
}

function rawLanguage(contentType: string | undefined, text: string): 'json' | 'text' | 'xml' | 'html' {
  const type = contentType?.toLowerCase() ?? ''
  if (type.includes('json')) return 'json'
  if (type.includes('xml')) return 'xml'
  if (type.includes('html')) return 'html'
  if (type === '' && /^\s*[[{]/.test(text)) {
    try {
      JSON.parse(text)
      return 'json'
    } catch {
      // not JSON: plain text
    }
  }
  return 'text'
}

/**
 * Parses a curl command into a request. Throws with a short message when it is not one (no `curl`, no URL, an
 * unterminated quote). Options that do not change what is sent (`-s`, `-L`, `-k`, `-o file`, …) are ignored.
 */
export function parseCurl(text: string): ParsedCurl {
  const words = shellWords(text.trim())
  if (words[0] === '$') words.shift()
  if (!/^curl(\.exe)?$/i.test(words[0] ?? '')) throw new Error('Not a curl command')

  // Set from inside `apply`, so kept in an object (a closure assignment does not widen a narrowed `let`).
  const opt: { method: string | null; user: string | null } = { method: null, user: null }
  let url: string | null = null
  let get = false
  let head = false
  const headers: KeyValue[] = []
  const data: DataPart[] = []
  const form: KeyValue[] = []
  const skipped: string[] = []
  let json = false

  const apply = (name: string, value: string) => {
    switch (name) {
      case 'X':
        opt.method = value.toUpperCase()
        break
      case 'H': {
        const h = header(value)
        if (h) headers.push(h)
        break
      }
      case 'd':
      case 'data-binary':
        // `@file` reads a file, which a pasted command cannot bring along.
        if (value.startsWith('@')) skipped.push(`file data ${value}`)
        else data.push({ kind: name === 'd' ? 'raw' : 'binary', value })
        break
      case 'data-raw':
        data.push({ kind: 'raw', value })
        break
      case 'data-urlencode':
        data.push({ kind: 'urlencode', value })
        break
      case 'json':
        json = true
        data.push({ kind: 'raw', value })
        break
      case 'F':
      case 'form-string': {
        const eq = value.indexOf('=')
        if (eq <= 0) break
        const content = value.slice(eq + 1)
        if (name === 'F' && (content.startsWith('@') || content.startsWith('<'))) {
          skipped.push(`file field ${value.slice(0, eq)}`)
          break
        }
        // A `;type=…` suffix is curl's, not part of the value.
        const plain = name === 'F' ? content.replace(/;type=[^;]*$/, '') : content
        form.push({ key: value.slice(0, eq), value: plain, enabled: true })
        break
      }
      case 'u':
        opt.user = value
        break
      case 'url':
        url ??= value
        break
      case 'b':
        if (value.includes('=')) headers.push({ key: 'Cookie', value, enabled: true })
        else skipped.push(`cookie file ${value}`)
        break
      case 'A':
        headers.push({ key: 'User-Agent', value, enabled: true })
        break
      case 'e':
        headers.push({ key: 'Referer', value, enabled: true })
        break
    }
  }

  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    if (w.startsWith('--') && w.length > 2) {
      const eqAt = w.indexOf('=')
      const name = eqAt > 0 ? w.slice(2, eqAt) : w.slice(2)
      const inline = eqAt > 0 ? w.slice(eqAt + 1) : undefined
      const takeValue = () => (inline !== undefined ? inline : (words[++i] ?? ''))
      if (Object.hasOwn(LONG_WITH_VALUE, name)) apply(LONG_WITH_VALUE[name], takeValue())
      else if (IGNORED_WITH_VALUE.has(name)) takeValue()
      else if (name === 'get') get = true
      else if (name === 'head') head = true
      continue
    }
    if (w.startsWith('-') && w.length > 1) {
      for (let j = 1; j < w.length; j++) {
        const flag = w[j]
        if (SHORT_WITH_VALUE.has(flag)) {
          const value = j + 1 < w.length ? w.slice(j + 1) : (words[++i] ?? '')
          if (!IGNORED_WITH_VALUE.has(flag)) apply(flag, value)
          break
        }
        if (flag === 'G') get = true
        else if (flag === 'I') head = true
      }
      continue
    }
    url ??= w
  }

  if (url === null || url === '') throw new Error('The curl command has no URL')
  let fullUrl: string = url
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(fullUrl) && !fullUrl.startsWith('{{')) fullUrl = `http://${fullUrl}`

  const contentTypeAt = headers.findIndex((h) => h.key.toLowerCase() === 'content-type')
  const contentType = contentTypeAt >= 0 ? headers[contentTypeAt].value : undefined
  const dataText = data.map((d) => (d.kind === 'urlencode' ? urlencodePart(d.value) : d.value)).join('&')

  let body: RequestBody = { mode: 'none' }
  if (get && data.length > 0) {
    fullUrl += (fullUrl.includes('?') ? '&' : '?') + dataText
  } else if (form.length > 0) {
    body = { mode: 'formdata', fields: form }
    // The boundary is generated on send; a copied one would not match.
    if (contentType?.toLowerCase().startsWith('multipart/')) headers.splice(contentTypeAt, 1)
  } else if (data.length > 0) {
    if (json && contentTypeAt < 0) {
      headers.push({ key: 'Content-Type', value: 'application/json', enabled: true })
      headers.push({ key: 'Accept', value: 'application/json', enabled: true })
    }
    const type = json ? 'application/json' : contentType
    const formLike = type === undefined || type.toLowerCase().startsWith('application/x-www-form-urlencoded')
    const fields = formLike ? formPairs(dataText) : null
    if (fields) {
      body = { mode: 'urlencoded', fields }
      if (contentTypeAt >= 0) headers.splice(contentTypeAt, 1)
    } else {
      body = { mode: 'raw', language: rawLanguage(type, dataText), content: dataText }
      // The raw language sets this type on send; an explicit header that says the same is redundant.
      const language = body.language
      const implied = { json: 'application/json', text: 'text/plain', xml: 'application/xml', html: 'text/html' }[
        language
      ]
      if (contentTypeAt >= 0 && !json && contentType?.toLowerCase() === implied) headers.splice(contentTypeAt, 1)
    }
  }

  const resolvedMethod = opt.method ?? (head ? 'HEAD' : body.mode !== 'none' ? 'POST' : 'GET')
  if (!(METHODS as readonly string[]).includes(resolvedMethod)) {
    throw new Error(`Unsupported method ${resolvedMethod}`)
  }

  let auth: Auth = { type: 'none' }
  const user = opt.user
  if (user !== null) {
    const colon = user.indexOf(':')
    auth = {
      type: 'basic',
      username: colon < 0 ? user : user.slice(0, colon),
      password: colon < 0 ? '' : user.slice(colon + 1),
    }
  }

  return { method: resolvedMethod as HttpMethod, url: fullUrl, headers, body, auth, skipped }
}
