import type { ParsedCookie } from '../../shared/types'

/** Parses one `Set-Cookie` header value. Attribute names keep the casing the server used. */
export function parseSetCookie(header: string): ParsedCookie {
  const [pair, ...rest] = header.split(';')
  const eq = pair.indexOf('=')
  const name = eq === -1 ? '' : pair.slice(0, eq).trim()
  const value = (eq === -1 ? pair : pair.slice(eq + 1)).trim()
  const attributes: Record<string, string | true> = {}
  for (const part of rest) {
    const attrEq = part.indexOf('=')
    const key = (attrEq === -1 ? part : part.slice(0, attrEq)).trim()
    if (key === '') continue
    attributes[key] = attrEq === -1 ? true : part.slice(attrEq + 1).trim()
  }
  return { name, value, attributes }
}
