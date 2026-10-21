import type { HttpResponse } from '../../../shared/types'

export type BodyKind = 'json' | 'xml' | 'html' | 'text' | 'image' | 'binary'

export interface DecodedBody {
  kind: BodyKind
  /** The body as text; only set when the bytes are text (valid in their charset). */
  text?: string
  /** A `data:` URL of the bytes; only set for previewable images. */
  dataUrl?: string
  /** The media type without parameters, lower-cased ('' when absent). */
  mime: string
  byteLength: number
  /** The text is too large to pretty-print or mount in the editor. */
  large: boolean
}

/** Texts above this many characters are shown raw and cut (see `LARGE_PREVIEW_CHARS`) instead of pretty-printed. */
export const LARGE_TEXT_CHARS = 2 * 1024 * 1024
export const LARGE_PREVIEW_CHARS = 256 * 1024

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])

export function headerValue(response: HttpResponse, name: string): string | undefined {
  const wanted = name.toLowerCase()
  return response.headers.find(([n]) => n.toLowerCase() === wanted)?.[1]
}

export function bodyBytes(response: HttpResponse): Uint8Array {
  try {
    const binary = atob(response.bodyBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return new Uint8Array(0)
  }
}

export function parseContentType(value: string | undefined): { mime: string; charset: string | null } {
  const parts = (value ?? '').split(';')
  const mime = (parts[0] ?? '').trim().toLowerCase()
  let charset: string | null = null
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim().toLowerCase() === 'charset') {
      charset = part
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, '')
    }
  }
  return { mime, charset: charset || null }
}

/** Decodes `bytes` as text, or returns null when they are not valid in the charset (UTF-8 unless declared). */
function decodeText(bytes: Uint8Array, charset: string | null): string | null {
  let label = 'utf-8'
  if (charset) {
    try {
      label = new TextDecoder(charset).encoding
    } catch {
      label = 'utf-8' // unknown charset label
    }
  }
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes)
  } catch {
    // Single-byte charsets leave some bytes undefined; everything else is genuinely not text.
    if (label === 'utf-8') return null
    try {
      return new TextDecoder(label).decode(bytes)
    } catch {
      return null
    }
  }
}

/** Removes a trailing, incomplete UTF-8 sequence (at most 3 bytes); other charsets are left alone. */
function dropIncompleteUtf8Tail(bytes: Uint8Array, charset: string | null): Uint8Array {
  if (charset && !/^utf-?8$/i.test(charset)) return bytes
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const b = bytes[bytes.length - back]!
    if ((b & 0xc0) === 0x80) continue // continuation byte: keep looking for its lead byte
    const needed = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    return needed > back ? bytes.subarray(0, bytes.length - back) : bytes
  }
  return bytes
}

function sniffImage(bytes: Uint8Array): string | null {
  const at = (i: number): number => bytes[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif'
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45) {
    return 'image/webp'
  }
  return null
}

function kindFromMime(mime: string): BodyKind | null {
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json'
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime === 'application/xml' || mime === 'text/xml' || mime.endsWith('+xml')) return 'xml'
  if (mime.startsWith('text/')) return 'text'
  return null
}

/** Guesses the kind of untyped text. Large texts are never parsed, only their first characters are looked at. */
function sniffTextKind(text: string, large: boolean): BodyKind {
  const head = text.slice(0, 2048).trimStart()
  if (!large && (head.startsWith('{') || head.startsWith('[')) && isJson(text)) return 'json'
  if (/^<(!doctype\s+html|html[\s>])/i.test(head)) return 'html'
  if (head.startsWith('<?xml') || /^<[A-Za-z]/.test(head)) return 'xml'
  return 'text'
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

export function decodeBody(response: HttpResponse): DecodedBody {
  const { mime, charset } = parseContentType(headerValue(response, 'content-type'))
  const bytes = bodyBytes(response)
  const base = { mime, byteLength: bytes.length, large: false }

  if (IMAGE_TYPES.has(mime)) return { ...base, kind: 'image', dataUrl: `data:${mime};base64,${response.bodyBase64}` }
  if (/^(image|audio|video|font)\//.test(mime)) return { ...base, kind: 'binary' }
  const declared = kindFromMime(mime)
  if (declared === null && bytes.length > 0) {
    const image = sniffImage(bytes)
    if (image) return { ...base, mime: image, kind: 'image', dataUrl: `data:${image};base64,${response.bodyBase64}` }
  }

  // NUL bytes never occur in the text formats handled here; treating them as binary keeps garbage out of the editor.
  // A size cap can split a multibyte character; that must not turn the whole body into binary.
  const textBytes = response.bodyTruncated ? dropIncompleteUtf8Tail(bytes, charset) : bytes
  const text = bytes.includes(0) && charset === null ? null : decodeText(textBytes, charset)
  if (text === null) return { ...base, kind: 'binary' }
  const large = text.length > LARGE_TEXT_CHARS
  return { ...base, kind: declared ?? sniffTextKind(text, large), text, large }
}

/** Indents valid JSON; anything else (including invalid or truncated JSON) is returned unchanged. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n || 0))} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n
  let i = -1
  do {
    value /= 1024
    i++
  } while (value >= 1024 && i < units.length - 1)
  return `${value.toFixed(1).replace(/\.0$/, '')} ${units[i]}`
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/css': 'css',
  'text/csv': 'csv',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

function fileNameFromDisposition(value: string): string | null {
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(value)
  let name: string | null = null
  if (star?.[2]) {
    try {
      name = decodeURIComponent(star[2].trim())
    } catch {
      name = star[2].trim()
    }
  } else {
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(value)
    name = (plain?.[1] ?? plain?.[2] ?? '').trim() || null
  }
  // Keep only the last path segment; the name must never steer the download elsewhere.
  const base = name?.split(/[\\/]/).pop()?.trim()
  return base && base !== '.' && base !== '..' ? base : null
}

export function suggestFileName(response: HttpResponse): string {
  const disposition = headerValue(response, 'content-disposition')
  const fromHeader = disposition ? fileNameFromDisposition(disposition) : null
  if (fromHeader) return fromHeader
  const { mime } = parseContentType(headerValue(response, 'content-type'))
  const ext = EXTENSIONS[mime] ?? (mime.endsWith('+json') ? 'json' : mime.endsWith('+xml') ? 'xml' : 'bin')
  return `response.${ext}`
}

/**
 * Indents well-formed XML two spaces per level; elements holding only text stay on one line. Anything that does not
 * parse is returned unchanged.
 */
export function prettyXml(text: string): string {
  try {
    const parsed = new DOMParser().parseFromString(text, 'application/xml')
    if (parsed.getElementsByTagName('parsererror').length > 0) return text
  } catch {
    return text
  }
  const tokens = text
    .trim()
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]+>)/)
    .filter((t) => t.trim() !== '')
  const lines: string[] = []
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.trim()
    const pad = '  '.repeat(depth)
    if (t.startsWith('</')) {
      depth = Math.max(0, depth - 1)
      lines.push('  '.repeat(depth) + t)
    } else if (t.startsWith('<?') || t.startsWith('<!') || t.endsWith('/>') || !t.startsWith('<')) {
      lines.push(pad + t)
    } else {
      const text = tokens[i + 1]
      const close = tokens[i + 2]
      if (text !== undefined && !text.trim().startsWith('<') && close?.trim().startsWith('</')) {
        lines.push(pad + t + text.trim() + close.trim())
        i += 2
      } else {
        lines.push(pad + t)
        depth++
      }
    }
  }
  return lines.join('\n')
}
