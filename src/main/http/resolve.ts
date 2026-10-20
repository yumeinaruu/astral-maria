import type { Auth, KeyValue, RequestBody, RequestItem } from '../../shared/types'

export type VariableScope = Record<string, string>

const VARIABLE = /\{\{\s*([^{}\s]+)\s*\}\}/g

/** Single pass: earlier scopes win, unknown variables stay literal, inserted values are not expanded again. */
export function resolveText(text: string, scopes: VariableScope[]): string {
  return text.replace(VARIABLE, (match, name: string) => {
    for (const scope of scopes) {
      if (Object.hasOwn(scope, name)) return scope[name]
    }
    return match
  })
}

export function resolveRequest(request: RequestItem, scopes: VariableScope[]): RequestItem {
  const text = (s: string) => resolveText(s, scopes)
  const rows = (items: KeyValue[]): KeyValue[] =>
    items.map((kv) => ({ ...kv, key: text(kv.key), value: text(kv.value) }))

  const resolveBody = (body: RequestBody): RequestBody => {
    switch (body.mode) {
      case 'none':
        return { mode: 'none' }
      case 'raw':
        return { ...body, content: text(body.content) }
      case 'urlencoded':
      case 'formdata':
        return { ...body, fields: rows(body.fields) }
    }
  }

  const resolveAuth = (auth: Auth): Auth => {
    switch (auth.type) {
      case 'none':
      case 'inherit':
        return { ...auth }
      case 'bearer':
        return { ...auth, token: text(auth.token) }
      case 'basic':
        return { ...auth, username: text(auth.username), password: text(auth.password) }
      case 'apikey':
        return { ...auth, key: text(auth.key), value: text(auth.value) }
    }
  }

  return {
    ...request,
    url: text(request.url),
    params: rows(request.params),
    headers: rows(request.headers),
    body: resolveBody(request.body),
    auth: resolveAuth(request.auth),
  }
}
