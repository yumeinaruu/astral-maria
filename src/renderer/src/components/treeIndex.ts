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

export function buildIndex(collections: CollectionTree[], expanded: Record<string, true>): TreeIndex {
  const byPath = new Map<string, ItemMeta>()
  const visible: string[] = []

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
      if (show) visible.push(node.path)
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
    visible.push(c.path)
    addNodes(c.children, c.path, Boolean(expanded[c.path]))
  }
  return { byPath, visible }
}
