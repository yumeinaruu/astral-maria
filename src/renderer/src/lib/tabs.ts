import type { CollectionTree, EnvVar, TreeNode } from '../../../shared/types'
import { buildIndex } from '../components/treeIndex'
import { environmentIdOf, loadPathOf, runnerPathOf, tabTarget, useApp } from '../state/store'
import { useUi } from '../state/ui'
import { GLOBALS_ID, GLOBALS_NAME, newId, uniqueName } from './environments'

/** Activates an open tab of any kind. */
export function activateTab(path: string): void {
  const s = useApp.getState()
  const envId = environmentIdOf(path)
  const runnerPath = runnerPathOf(path)
  const loadPath = loadPathOf(path)
  if (envId !== null) s.openEnvironment(envId)
  else if (runnerPath !== null) s.openRunner(runnerPath)
  else if (loadPath !== null) s.openLoadTest(loadPath)
  else if (s.containerDrafts[path]) s.openContainer(path)
  else s.openRequest(path)
}

/**
 * Where "New request" puts the request: the folder or collection of the active request, or the active collection or
 * folder tab (or Runner tab) itself, else the first collection. A Load test tab counts as its target.
 */
export function newRequestParent(collections: CollectionTree[], activePath: string | null): string | null {
  if (activePath !== null && environmentIdOf(activePath) === null) {
    const meta = buildIndex(collections, {}).byPath.get(tabTarget(activePath))
    const parent = meta && meta.kind !== 'request' ? meta.path : meta?.parentPath
    if (parent) return parent
  }
  return collections[0]?.path ?? null
}

function childrenOf(collections: CollectionTree[], path: string): TreeNode[] {
  const walk = (nodes: TreeNode[]): TreeNode[] | null => {
    for (const n of nodes) {
      if (n.kind !== 'folder') continue
      if (n.path === path) return n.children
      const found = walk(n.children)
      if (found) return found
    }
    return null
  }
  for (const c of collections) {
    if (c.path === path) return c.children
    const found = walk(c.children)
    if (found) return found
  }
  return []
}

/** Creates "New request" (numbered if the name is taken) next to the active request and opens it in a tab. */
export async function createRequestHere(): Promise<void> {
  const { collections, activePath, createRequest } = useApp.getState()
  const parent = newRequestParent(collections, activePath)
  if (parent === null) return
  const name = uniqueName(
    'New request',
    childrenOf(collections, parent).map((n) => n.name),
  )
  await createRequest(parent, name)
  const created = childrenOf(useApp.getState().collections, parent).find((n) => n.kind === 'request' && n.name === name)
  if (created) useApp.getState().openRequest(created.path)
}

/** Opens the editor of the active environment, or of Globals when none is active. */
export function openActiveEnvironment(): void {
  const { activeEnvironmentId, openEnvironment } = useApp.getState()
  openEnvironment(activeEnvironmentId ?? GLOBALS_ID)
}

/**
 * Creates an environment on disk right away, named `base` (numbered if taken), opens its tab and puts its sidebar row
 * into inline rename. Used by "New environment" and "Duplicate".
 */
export async function createEnvironment(base = 'New environment', variables: EnvVar[] = []): Promise<void> {
  const { environments, saveEnvironment } = useApp.getState()
  const name = uniqueName(base, [...environments.map((e) => e.name), GLOBALS_NAME])
  const id = newId()
  try {
    if (!(await saveEnvironment({ id, name, variables }))) return
  } catch (e) {
    useApp.setState({
      error: `Could not create the environment "${name}": ${e instanceof Error ? e.message : String(e)}`,
    })
    return
  }
  useUi.getState().setSectionOpen('environments', true)
  useApp.getState().openEnvironment(id)
  useUi.getState().setRenamingEnvironment(id)
}
