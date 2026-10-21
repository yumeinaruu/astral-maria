import type { CollectionTree, HttpMethod, TreeNode } from '../../../shared/types'

export interface RequestHit {
  path: string
  name: string
  method: HttpMethod
  /** Where the request lives, e.g. `Shop / Users`. */
  location: string
}

/** Every request of every collection, in tree order. */
export function allRequests(collections: CollectionTree[]): RequestHit[] {
  const out: RequestHit[] = []
  const walk = (nodes: TreeNode[], trail: string[]): void => {
    for (const node of nodes) {
      if (node.kind === 'request') {
        out.push({ path: node.path, name: node.name, method: node.request.method, location: trail.join(' / ') })
      } else walk(node.children, [...trail, node.name])
    }
  }
  for (const c of collections) walk(c.children, [c.name])
  return out
}

/**
 * Requests whose name, or location plus name, contains every word of `query` (case-insensitive). Names that start
 * with the query come first; otherwise the tree order is kept.
 */
export function searchRequests(collections: CollectionTree[], query: string, limit = 50): RequestHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const q = query.trim().toLowerCase()
  const hits = allRequests(collections).filter((r) => {
    const text = `${r.location} / ${r.name} ${r.method}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
  const starts = hits.filter((r) => r.name.toLowerCase().startsWith(q))
  const rest = hits.filter((r) => !r.name.toLowerCase().startsWith(q))
  return [...starts, ...rest].slice(0, limit)
}
