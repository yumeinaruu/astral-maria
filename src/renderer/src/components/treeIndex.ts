import type { CollectionTree, HttpMethod, TreeNode } from '../../../shared/types'

export type ItemKind = 'collection' | 'folder' | 'request'

export interface ItemMeta {
  path: string
  name: string
  kind: ItemKind
  method?: HttpMethod
  /** null for collections. */
  parentPath: string | null
  childPaths: string[]
  siblingPaths: string[]
}

export interface TreeIndex {
  byPath: Map<string, ItemMeta>
  /** Paths in display order, only items whose ancestors are all expanded. */
  visible: string[]
}

export function isContainer(kind: ItemKind): boolean {
  return kind !== 'request'
}

export function isWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

/**
 * The paths a sidebar filter keeps: requests whose name contains `query` (case-insensitive) and all their ancestors.
 * Null when there is nothing to filter by.
 */
export function filterPaths(collections: CollectionTree[], query: string): Set<string> | null {
  const q = query.trim().toLowerCase()
  if (q === '') return null
  const keep = new Set<string>()
  const walk = (nodes: TreeNode[], trail: string[]): void => {
    for (const node of nodes) {
      if (node.kind === 'request') {
        if (node.name.toLowerCase().includes(q)) for (const p of [...trail, node.path]) keep.add(p)
      } else walk(node.children, [...trail, node.path])
    }
  }
  for (const c of collections) walk(c.children, [c.path])
  return keep
}

/**
 * Indexes the tree. With `keep` (see `filterPaths`) only those paths are visible, and every kept container counts
 * as expanded.
 */
export function buildIndex(
  collections: CollectionTree[],
  expandedState: Record<string, true>,
  keep: Set<string> | null = null,
): TreeIndex {
  const byPath = new Map<string, ItemMeta>()
  const visible: string[] = []
  const expanded: Record<string, boolean> = keep ? Object.fromEntries([...keep].map((p) => [p, true])) : expandedState

  function addNodes(nodes: TreeNode[], parentPath: string, show: boolean): void {
    const siblingPaths = nodes.map((n) => n.path)
    for (const node of nodes) {
      byPath.set(node.path, {
        path: node.path,
        name: node.name,
        kind: node.kind,
        method: node.kind === 'request' ? node.request.method : undefined,
        parentPath,
        childPaths: node.kind === 'folder' ? node.children.map((c) => c.path) : [],
        siblingPaths,
      })
      if (show && (!keep || keep.has(node.path))) visible.push(node.path)
      if (node.kind === 'folder') addNodes(node.children, node.path, show && Boolean(expanded[node.path]))
    }
  }

  const collectionPaths = collections.map((c) => c.path)
  for (const c of collections) {
    byPath.set(c.path, {
      path: c.path,
      name: c.name,
      kind: 'collection',
      parentPath: null,
      childPaths: c.children.map((n) => n.path),
      siblingPaths: collectionPaths,
    })
    if (!keep || keep.has(c.path)) visible.push(c.path)
    addNodes(c.children, c.path, Boolean(expanded[c.path]))
  }
  return { byPath, visible }
}
