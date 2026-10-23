import { ChevronDown, Folder, Gauge, Layers, Library, ListChecks, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { draftProblem, GLOBALS_NAME, isDraftDirty } from '../lib/environments'
import { hasMod } from '../lib/platform'
import { activateTab, createRequestHere } from '../lib/tabs'
import {
  containerNames,
  environmentIdOf,
  loadPathOf,
  loadTargetOf,
  runnerPathOf,
  useApp,
  type AppState,
} from '../state/store'
import { ConfirmDialog } from './ConfirmDialog'
import { EnvironmentSelector } from './EnvironmentSelector'
import { MenuButton } from './MenuButton'
import { MethodBadge } from './MethodBadge'

export function tabDomId(path: string): string {
  return `request-tab-${path.replace(/\s/g, '_')}`
}

function basename(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.request\.json$/, '')
}

interface TabInfo {
  path: string
  name: string
  env: boolean
  /** Set on the settings tab of a collection or folder. */
  container?: 'collection' | 'folder'
  /** Set on a Runner tab. */
  runner?: boolean
  /** Set on a Load test tab. */
  load?: boolean
  method?: AppState['drafts'][string]['method']
  dirty: boolean
}

function describeTab(s: AppState, path: string): TabInfo {
  const envId = environmentIdOf(path)
  if (envId !== null) {
    const entry = s.environmentDrafts[envId]
    const name = entry?.draft.name || s.environments.find((e) => e.id === envId)?.name || GLOBALS_NAME
    return { path, name, env: true, dirty: entry ? isDraftDirty(entry) : false }
  }
  const runnerPath = runnerPathOf(path)
  if (runnerPath !== null) {
    const name = containerNames(s.collections, runnerPath)?.name ?? basename(runnerPath)
    return { path, name: `Runner · ${name}`, env: false, runner: true, dirty: false }
  }
  const loadPath = loadPathOf(path)
  if (loadPath !== null) {
    const name = loadTargetOf(s.collections, s.drafts, loadPath)?.name ?? basename(loadPath)
    return { path, name: `Load · ${name}`, env: false, load: true, dirty: false }
  }
  const settings = s.containerDrafts[path]
  if (settings) {
    return { path, name: settings.name, env: false, container: settings.kind, dirty: Boolean(s.saves[path]) }
  }
  const draft = s.drafts[path]
  return { path, name: draft?.name ?? basename(path), env: false, method: draft?.method, dirty: Boolean(s.saves[path]) }
}

/** Why closing `path` needs a confirmation (its changes would be lost), or null. */
function closeWarning(s: AppState, path: string): string | null {
  const envId = environmentIdOf(path)
  const name = describeTab(s, path).name
  if (envId !== null) {
    const entry = s.environmentDrafts[envId]
    const problem = entry && isDraftDirty(entry) ? draftProblem(entry.draft, s.environments) : null
    return problem
      ? `The changes to "${name || 'Unnamed'}" cannot be saved (${problem}). Close the tab and discard them?`
      : null
  }
  const save = s.saves[path]
  if (save?.state !== 'failed' && save?.state !== 'conflict') return null
  const reason = save.state === 'conflict' ? ' (the file was changed on disk)' : save.error ? ` (${save.error})` : ''
  return `The latest changes to "${name}" could not be saved${reason}. Close the tab and discard them?`
}

/**
 * The strip of open requests and environments, with New request, the list of all tabs and the environment selector.
 * Also handles the tab shortcuts: Cmd/Ctrl+W, Cmd/Ctrl+T and Ctrl+(Shift+)Tab.
 */
export function RequestTabs(): React.JSX.Element {
  const openTabs = useApp((s) => s.openTabs)
  const activePath = useApp((s) => s.activePath)
  // What the tabs show; subscribing to these slices re-renders the strip when any of them changes.
  useApp((s) => s.drafts)
  useApp((s) => s.saves)
  useApp((s) => s.environmentDrafts)
  useApp((s) => s.environments)
  useApp((s) => s.containerDrafts)
  useApp((s) => s.collections)
  const described = openTabs.map((t) => describeTab(useApp.getState(), t.path))
  const hasCollections = useApp((s) => s.collections.length > 0)
  const [closing, setClosing] = useState<{ path: string; message: string } | null>(null)

  function close(path: string): void {
    const message = closeWarning(useApp.getState(), path)
    if (message) setClosing({ path, message })
    else useApp.getState().closeTab(path)
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented) return
      const s = useApp.getState()
      const key = e.key.toLowerCase()
      if (hasMod(e) && !e.shiftKey && !e.altKey && key === 'w') {
        e.preventDefault()
        if (s.activePath !== null) close(s.activePath)
      } else if (hasMod(e) && !e.shiftKey && !e.altKey && key === 't') {
        e.preventDefault()
        void createRequestHere()
      } else if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault()
        const paths = s.openTabs.map((t) => t.path)
        if (paths.length === 0) return
        const at = s.activePath === null ? -1 : paths.indexOf(s.activePath)
        const next = paths[(at + (e.shiftKey ? -1 : 1) + paths.length) % paths.length]
        if (next !== undefined) activateTab(next)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function onKeyDown(e: React.KeyboardEvent, index: number): void {
    const last = openTabs.length - 1
    const target =
      e.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : e.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (target === null) return
    e.preventDefault()
    const path = openTabs[target]?.path
    if (path === undefined) return
    activateTab(path)
    document.getElementById(tabDomId(path))?.focus()
  }

  return (
    <div className="tabstrip">
      <div className="tabs-scroll" role="tablist" aria-label="Open tabs">
        {described.map((tab, i) => {
          const active = tab.path === activePath
          return (
            <div
              key={tab.path}
              role="presentation"
              className={`tab${active ? ' tab-active' : ''}${tab.dirty ? ' tab-dirty' : ''}`}
              onMouseDown={(e) => {
                // Middle-click closes, as in browsers; preventing the default stops autoscroll.
                if (e.button === 1) e.preventDefault()
              }}
              onAuxClick={(e) => {
                if (e.button === 1) close(tab.path)
              }}
            >
              <button
                type="button"
                role="tab"
                id={tabDomId(tab.path)}
                className="tab-main"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                title={tab.env ? `Environment: ${tab.name}` : tab.path}
                onClick={() => activateTab(tab.path)}
                onKeyDown={(e) => onKeyDown(e, i)}
              >
                {tab.env ? (
                  <Layers size={13} aria-hidden="true" />
                ) : tab.runner ? (
                  <ListChecks size={13} aria-hidden="true" />
                ) : tab.load ? (
                  <Gauge size={13} aria-hidden="true" />
                ) : tab.container === 'collection' ? (
                  <Library size={13} aria-hidden="true" />
                ) : tab.container === 'folder' ? (
                  <Folder size={13} aria-hidden="true" />
                ) : (
                  tab.method && <MethodBadge method={tab.method} />
                )}
                <span className="tab-name">{tab.name || 'Unnamed'}</span>
                {tab.dirty && <span className="sr-only">Unsaved changes</span>}
              </button>
              <span className="tab-end">
                {tab.dirty && <span className="dirty-dot" aria-hidden="true" />}
                <button
                  type="button"
                  className="tab-close"
                  aria-label={`Close ${tab.name || 'Unnamed'}`}
                  title="Close tab"
                  onClick={() => close(tab.path)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </span>
            </div>
          )
        })}
      </div>
      <div className="tabstrip-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label="New request"
          title="New request"
          disabled={!hasCollections}
          onClick={() => void createRequestHere()}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <MenuButton
          label="All tabs"
          disabled={described.length === 0}
          items={() =>
            described.map((t) => ({
              label: t.env
                ? `${t.name || 'Unnamed'} (environment)`
                : t.runner || t.load
                  ? t.name
                  : t.container
                  ? `${t.name} (${t.container})`
                  : `${t.method ?? ''} ${t.name}`.trim(),
              checked: t.path === useApp.getState().activePath,
              onSelect: () => activateTab(t.path),
            }))
          }
        >
          <ChevronDown size={16} aria-hidden="true" />
        </MenuButton>
      </div>
      <EnvironmentSelector />
      {closing !== null && (
        <ConfirmDialog
          title="Unsaved changes"
          message={closing.message}
          confirmLabel="Close and discard"
          onConfirm={() => {
            const path = closing.path
            setClosing(null)
            useApp.getState().closeTab(path, { discard: true })
          }}
          onCancel={() => setClosing(null)}
        />
      )}
    </div>
  )
}
