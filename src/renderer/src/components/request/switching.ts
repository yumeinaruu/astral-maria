import type { Auth, RequestBody, RequestItem } from '../../../../shared/types'

export interface PanelProps {
  draft: RequestItem
  edit(patch: Partial<RequestItem>): void
}

/**
 * The body and auth settings a request had before the user switched to another mode, so switching back within the
 * session does not lose them. Keyed by request id; intentionally not persisted.
 */
const switchedAway = new Map<string, RequestBody | Auth>()

export function remember(id: string, kind: 'body' | 'auth', value: RequestBody | Auth): void {
  switchedAway.set(`${id}:${kind}:${'mode' in value ? value.mode : value.type}`, value)
}

export function recall<T extends RequestBody | Auth>(
  id: string,
  kind: 'body' | 'auth',
  variant: string,
  fallback: T,
): T {
  return (switchedAway.get(`${id}:${kind}:${variant}`) as T | undefined) ?? fallback
}
