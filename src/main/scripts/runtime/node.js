// Evaluated right after pm.js, in the same scope, so it reuses pm.js's `g`, `define` and `hasOwn`.
//
// Node-style helpers that scripts written for Postman commonly use: Buffer, atob, btoa, TextEncoder and TextDecoder,
// plus require('buffer'), require('atob') and require('btoa'). QuickJS itself has none of them. Only the encodings
// below are supported, which covers decoding tokens and building Basic auth headers.

/* global g, define, hasOwn */

const ENCODINGS = ['utf8', 'utf-8', 'base64', 'base64url', 'hex', 'latin1', 'binary', 'ascii']

function normalizeEncoding(encoding) {
  const e = encoding === undefined || encoding === null ? 'utf8' : String(encoding).toLowerCase()
  if (!ENCODINGS.includes(e)) throw new Error('Buffer: unsupported encoding "' + encoding + '" in Astral Maria')
  if (e === 'utf-8') return 'utf8'
  if (e === 'binary') return 'latin1'
  return e
}

function utf8Encode(text) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00)
        i++
      }
    }
    // A lone surrogate becomes U+FFFD, as in Node.
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

function utf8Decode(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    let need = 0
    let cp = 0
    let min = 0
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i++
      continue
    } else if (b >= 0xc2 && b <= 0xdf) {
      need = 1
      cp = b & 0x1f
      min = 0x80
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2
      cp = b & 0x0f
      min = 0x800
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3
      cp = b & 0x07
      min = 0x10000
    } else {
      out += '�'
      i++
      continue
    }
    let j = 1
    for (; j <= need; j++) {
      const next = bytes[i + j]
      if (next === undefined || (next & 0xc0) !== 0x80) break
      cp = (cp << 6) | (next & 0x3f)
    }
    if (j <= need || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += '�'
      i += Math.max(1, j)
      continue
    }
    out += String.fromCodePoint(cp)
    i += need + 1
  }
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_VALUE = {}
for (let i = 0; i < B64.length; i++) B64_VALUE[B64[i]] = i
B64_VALUE['-'] = 62
B64_VALUE['_'] = 63

/** Lenient, like Node: accepts base64 and base64url, missing padding, and skips characters outside the alphabet. */
function base64Decode(text) {
  const out = []
  let bits = 0
  let value = 0
  for (const ch of text) {
    if (ch === '=') break
    const v = B64_VALUE[ch]
    if (v === undefined) continue
    value = (value << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((value >> bits) & 0xff)
    }
  }
  return out
}

function base64Encode(bytes, url) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] + '=' : '=='
  }
  return url ? out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : out
}

function encode(text, encoding) {
  switch (normalizeEncoding(encoding)) {
    case 'utf8':
      return utf8Encode(text)
    case 'base64':
    case 'base64url':
      return base64Decode(text)
    case 'hex': {
      const out = []
      for (let i = 0; i + 1 < text.length; i += 2) {
        const byte = parseInt(text.slice(i, i + 2), 16)
        if (Number.isNaN(byte)) break
        out.push(byte)
      }
      return out
    }
    case 'latin1':
      return Array.from(text, (ch) => ch.charCodeAt(0) & 0xff)
    case 'ascii':
      return Array.from(text, (ch) => ch.charCodeAt(0) & 0x7f)
  }
}

function decode(bytes, encoding) {
  switch (normalizeEncoding(encoding)) {
    case 'utf8':
      return utf8Decode(bytes)
    case 'base64':
      return base64Encode(bytes, false)
    case 'base64url':
      return base64Encode(bytes, true)
    case 'hex':
      return Array.from(bytes, (b) => (b < 16 ? '0' : '') + b.toString(16)).join('')
    case 'latin1':
      return Array.from(bytes, (b) => String.fromCharCode(b)).join('')
    case 'ascii':
      return Array.from(bytes, (b) => String.fromCharCode(b & 0x7f)).join('')
  }
}

class Buffer extends Uint8Array {
  static from(value, encodingOrOffset, length) {
    if (typeof value === 'string') return new Buffer(encode(value, encodingOrOffset))
    if (value instanceof ArrayBuffer) {
      const offset = encodingOrOffset ?? 0
      return new Buffer(new Uint8Array(value, offset, length ?? value.byteLength - offset))
    }
    if (value !== null && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
      return new Buffer(value.data)
    }
    if (ArrayBuffer.isView(value) || Array.isArray(value)) return new Buffer(Array.from(value, (b) => b & 0xff))
    throw new TypeError('Buffer.from: expected a string, array, ArrayBuffer or Buffer')
  }

  static alloc(size, fill = 0, encoding) {
    const buf = new Buffer(size)
    if (fill !== 0) buf.fill(fill, 0, size, encoding)
    return buf
  }

  static isBuffer(value) {
    return value instanceof Buffer
  }

  static isEncoding(encoding) {
    return typeof encoding === 'string' && ENCODINGS.includes(encoding.toLowerCase())
  }

  static byteLength(value, encoding) {
    return typeof value === 'string' ? encode(value, encoding).length : value.byteLength
  }

  static concat(list, totalLength) {
    const total = totalLength ?? list.reduce((n, b) => n + b.length, 0)
    const out = Buffer.alloc(total)
    let offset = 0
    for (const b of list) {
      if (offset >= total) break
      const part = b.length > total - offset ? b.subarray(0, total - offset) : b
      out.set(part, offset)
      offset += part.length
    }
    return out
  }

  fill(value, start = 0, end = this.length, encoding) {
    if (typeof value === 'string') {
      const bytes = encode(value, encoding)
      if (bytes.length === 0) return super.fill(0, start, end)
      for (let i = start, j = 0; i < end; i++, j = (j + 1) % bytes.length) this[i] = bytes[j]
      return this
    }
    return super.fill(value, start, end)
  }

  toString(encoding, start = 0, end = this.length) {
    return decode(this.subarray(start, end), encoding)
  }

  toJSON() {
    return { type: 'Buffer', data: Array.from(this) }
  }

  equals(other) {
    if (other.length !== this.length) return false
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false
    return true
  }

  write(text, offset = 0, encoding) {
    const bytes = encode(text, encoding)
    const n = Math.min(bytes.length, this.length - offset)
    for (let i = 0; i < n; i++) this[offset + i] = bytes[i]
    return n
  }
}

function btoa(text) {
  const s = String(text)
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) throw new Error('btoa: the string contains characters outside of the Latin1 range')
  }
  return base64Encode(Array.from(s, (ch) => ch.charCodeAt(0)), false)
}

function atob(text) {
  return Array.from(base64Decode(String(text)), (b) => String.fromCharCode(b)).join('')
}

class TextEncoder {
  get encoding() {
    return 'utf-8'
  }
  encode(text = '') {
    return new Uint8Array(utf8Encode(String(text)))
  }
}

class TextDecoder {
  constructor(label = 'utf-8') {
    if (normalizeEncoding(label) !== 'utf8') throw new Error('TextDecoder: only utf-8 is supported in Astral Maria')
  }
  get encoding() {
    return 'utf-8'
  }
  decode(bytes) {
    if (bytes === undefined) return ''
    const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return utf8Decode(view)
  }
}

define('Buffer', Buffer)
define('atob', atob)
define('btoa', btoa)
define('TextEncoder', TextEncoder)
define('TextDecoder', TextDecoder)

const MODULES = { buffer: { Buffer }, atob, btoa }
const baseRequire = g.require
define('require', function require(name) {
  if (typeof name === 'string' && hasOwn(MODULES, name)) return MODULES[name]
  return baseRequire(name)
})
