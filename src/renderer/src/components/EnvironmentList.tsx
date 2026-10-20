import { CheckCircle2, Circle, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import type { Environment } from '../../../shared/types'
import {
  fingerprint,
  GLOBALS_ID,
  GLOBALS_NAME,
  nameProblem,
  otherNames,
  toDraft,
  toEnvironment,
} from '../lib/environments'
import { environmentTabId, useApp } from '../state/store'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu } from './ContextMenu'
import { NameInput } from './NameInput'

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The ENVIRONMENTS section: Globals, then every environment, with the active check and Rename / Delete. */
export function EnvironmentList(): React.JSX.Element {
  const environments = useApp((s) => s.environments)
  const activeId = useApp((s) => s.activeEnvironmentId)
  const activeTab = useApp((s) => s.activePath)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Environment | null>(null)
  const [menu, setMenu] = useState<{ env: Environment; x: number; y: number; button: HTMLElement } | null>(null)

  const listed = environments.filter((e) => e.id !== GLOBALS_ID)
  const globals = environments.find((e) => e.id === GLOBALS_ID) ?? { id: GLOBALS_ID, name: GLOBALS_NAME, variables: [] }

  async function rename(env: Environment, name: string): Promise<void> {
    setRenaming(null)
    if (name === env.name) return
    const draft = { ...toDraft(env), name }
    const problem = nameProblem(name, otherNames(draft, useApp.getState().environments))
    if (problem) {
      useApp.setState({ error: `Cannot rename "${env.name}": ${problem}` })
      return
    }
    try {
      await useApp.getState().saveEnvironment(toEnvironment(draft))
      // An open editor of it takes the new name as saved; its other changes stay as they are.
      useApp.getState().editEnvironmentDraft(env.id, (entry) => ({
        draft: { ...entry.draft, name },
        baseline: fingerprint({ ...(JSON.parse(entry.baseline) as Environment), name }),
      }))
    } catch (e) {
      useApp.setState({ error: `Could not rename "${env.name}": ${messageOf(e)}` })
    }
  }

  async function remove(env: Environment): Promise<void> {
    setDeleting(null)
    try {
      await useApp.getState().removeEnvironment(env.id)
    } catch (e) {
      useApp.setState({ error: `Could not delete "${env.name}": ${messageOf(e)}` })
    }
  }

  function row(env: Environment, isGlobals: boolean): React.JSX.Element {
    const active = !isGlobals && env.id === activeId
    const open = activeTab === environmentTabId(env.id)
    return (
      <li
        key={env.id}
        className={`env-row${open ? ' active' : ''}`}
        onContextMenu={(e) => {
          if (isGlobals) return
          e.preventDefault()
          setMenu({ env, x: e.clientX, y: e.clientY, button: e.currentTarget })
        }}
      >
        {renaming === env.id ? (
          <NameInput
            initial={env.name}
            onCommit={(name) => void rename(env, name)}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <button
            type="button"
            className="env-row-name"
            aria-current={open ? 'page' : undefined}
            title={isGlobals ? 'Variables available in every environment' : env.name}
            onClick={() => useApp.getState().openEnvironment(env.id)}
          >
            {env.name}
          </button>
        )}
        {!isGlobals && (
          <>
            <button
              type="button"
              className="row-menu"
              aria-label={`Actions for ${env.name}`}
              aria-haspopup="menu"
              aria-expanded={menu?.env.id === env.id}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                setMenu({ env, x: rect.left, y: rect.bottom + 2, button: e.currentTarget })
              }}
            >
              <MoreHorizontal size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="env-check"
              aria-pressed={active}
              aria-label={active ? `Deactivate ${env.name}` : `Activate ${env.name}`}
              title={active ? 'Active environment (click to deactivate)' : 'Set as active environment'}
              onClick={() => useApp.getState().setActiveEnvironment(active ? null : env.id)}
            >
              {active ? (
                <CheckCircle2 size={16} aria-hidden="true" fill="currentColor" stroke="var(--bg-chrome)" />
              ) : (
                <Circle size={15} aria-hidden="true" />
              )}
            </button>
          </>
        )}
      </li>
    )
  }

  return (
    <>
      <ul className="env-list" aria-label="Environments">
        {row(globals, true)}
        {listed.map((env) => row(env, false))}
      </ul>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.env.name}
          anchor={menu.button}
          items={[
            { label: 'Rename', onSelect: () => setRenaming(menu.env.id) },
            { label: 'Delete', danger: true, onSelect: () => setDeleting(menu.env) },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete environment"
          message={`Delete "${deleting.name}"? Its file in the workspace and its values on this machine are removed.`}
          confirmLabel="Delete"
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
}
