import { ChevronRight, Folder, Gauge, Info, Library, Play, Save } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import type { Auth } from '../../../shared/types'
import { shortcut } from '../lib/platform'
import { variableLookup, variableOptions } from '../lib/variables'
import { useApp, type ContainerSettings } from '../state/store'
import { KeyValueTable } from './KeyValueTable'
import { AuthPanel } from './request/AuthPanel'
import { trailOf } from './request/Breadcrumb'
import { hasScripts, ScriptsPanel } from './request/ScriptsPanel'
import { VariableOptionsContext, VariablesContext } from './VarInput'

type Section = 'Authorization' | 'Scripts' | 'Variables'

const COLLECTION_SECTIONS: Section[] = ['Authorization', 'Scripts', 'Variables']
const FOLDER_SECTIONS: Section[] = ['Scripts']

const VARIABLES_HELP =
  'Collection variables are used by every request in this collection. They are saved in the workspace folder and synced with git.'

/**
 * The settings tab of a collection (authorization, scripts and variables) or a folder (scripts). Edits are drafts,
 * autosaved like requests and saved at once with Save or Cmd/Ctrl+S.
 */
export function ContainerEditor({ path }: { path: string }): React.JSX.Element {
  const draft = useApp((s) => s.containerDrafts[path])
  const [chosen, setChosen] = useState<Section | null>(null)
  const idBase = useId()
  const variables = useVariables(path)

  // Cmd/Ctrl+S saves wherever the focus is; captured, so an editor that stops the key cannot swallow it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void useApp.getState().saveNow(path)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [path])

  if (!draft) return <p className="muted editor-loading">Loading…</p>

  const isCollection = draft.kind === 'collection'
  const sections = isCollection ? COLLECTION_SECTIONS : FOLDER_SECTIONS
  const section = chosen !== null && sections.includes(chosen) ? chosen : sections[0]!
  const edit = (patch: Partial<ContainerSettings>): void =>
    useApp.getState().editContainerDraft(path, (d) => ({ ...d, ...patch }))
  // Without scripts the field is left out of the draft; saving writes them as empty.
  const editScripts = (scripts: ContainerSettings['scripts']): void =>
    useApp.getState().editContainerDraft(path, ({ scripts: _old, ...rest }) => (scripts ? { ...rest, scripts } : rest))
  const variableCount = draft.variables.filter((v) => v.enabled && v.key !== '').length
  const marks: Record<Section, boolean> = {
    Authorization: draft.auth.type !== 'none' && draft.auth.type !== 'inherit',
    Scripts: hasScripts(draft.scripts),
    Variables: false,
  }

  function onTabKeyDown(e: React.KeyboardEvent, index: number): void {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const target = sections[(index + step + sections.length) % sections.length]!
    setChosen(target)
    document.getElementById(`${idBase}-${target}`)?.focus()
  }

  return (
    <VariablesContext.Provider value={variables.lookup}>
      <VariableOptionsContext.Provider value={variables.options}>
        <div className="container-editor">
          <Header path={path} draft={draft} />
          <div className="section-row">
            <div
              className="pill-tabs"
              role="tablist"
              aria-label={isCollection ? 'Collection sections' : 'Folder sections'}
            >
              {sections.map((name, i) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  id={`${idBase}-${name}`}
                  aria-selected={section === name}
                  aria-controls={`${idBase}-panel`}
                  tabIndex={section === name ? 0 : -1}
                  className="pill-tab"
                  onClick={() => setChosen(name)}
                  onKeyDown={(e) => onTabKeyDown(e, i)}
                >
                  {name}
                  {name === 'Variables' && variableCount > 0 && <span className="pill-count"> ({variableCount})</span>}
                  {marks[name] && (
                    <>
                      <span className="config-dot" aria-hidden="true" />
                      <span className="sr-only"> (configured)</span>
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>
          {!isCollection && (
            <p className="container-note">
              <Info size={14} aria-hidden="true" />
              Folder authorization is inherited from the collection
            </p>
          )}
          <div
            role="tabpanel"
            id={`${idBase}-panel`}
            aria-labelledby={`${idBase}-${section}`}
            className="section-panel container-panel"
          >
            {section === 'Authorization' && (
              <AuthPanel id={path} auth={draft.auth} onChange={(auth: Auth) => edit({ auth })} path={path} collection />
            )}
            {section === 'Scripts' && <ScriptsPanel scripts={draft.scripts} onChange={editScripts} />}
            {section === 'Variables' && (
              <>
                <p className="container-help">{VARIABLES_HELP}</p>
                <KeyValueTable noun="variable" rows={draft.variables} onChange={(rows) => edit({ variables: rows })} />
              </>
            )}
          </div>
        </div>
      </VariableOptionsContext.Provider>
    </VariablesContext.Provider>
  )
}

/** The icon, the parent trail and the editable name, then the save status and Save. */
function Header({ path, draft }: { path: string; draft: ContainerSettings }): React.JSX.Element {
  const trail = useApp((s) => trailOf(s.collections, path).join('\u0000'))
  const save = useApp((s) => s.saves[path])
  const store = useApp.getState
  const noun = draft.kind === 'collection' ? 'Collection' : 'Folder'
  const Icon = draft.kind === 'collection' ? Library : Folder

  return (
    <div className="crumb-row">
      <nav className="crumbs" aria-label={`${noun} location`}>
        <Icon className="container-icon" size={16} aria-hidden="true" />
        {trail
          .split('\u0000')
          .filter(Boolean)
          .map((part, i) => (
            <span key={i} className="crumb">
              <span className="crumb-part">{part}</span>
              <ChevronRight size={13} aria-hidden="true" />
            </span>
          ))}
        <input
          key={draft.name}
          className="crumb-name"
          type="text"
          aria-label={`${noun} name`}
          title="Rename"
          defaultValue={draft.name}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') {
              e.currentTarget.value = draft.name
              e.currentTarget.blur()
            }
          }}
          onBlur={(e) => {
            const next = e.currentTarget.value.trim()
            if (next && next !== draft.name) void store().rename(path, next)
            else e.currentTarget.value = draft.name
          }}
        />
      </nav>
      <div className="save-area">
        <span
          role="status"
          className={`save-status${save?.state === 'failed' ? ' save-status-failed' : ''}${save === undefined ? ' sr-only' : ''}`}
          title={save?.error}
        >
          {save === undefined
            ? 'Saved'
            : save.state === 'failed'
              ? `Save failed: ${save.error ?? 'unknown error'}`
              : 'Saving…'}
        </span>
        <button
          type="button"
          className="btn-text save-btn"
          disabled={save === undefined}
          title={`Save (${shortcut('S')})`}
          onClick={() => void store().saveNow(path)}
        >
          <Save size={14} aria-hidden="true" />
          Save
        </button>
        <button
          type="button"
          className="btn"
          title={`Run this ${noun.toLowerCase()}`}
          onClick={() => store().openRunner(path)}
        >
          <Play size={14} aria-hidden="true" />
          Run
        </button>
        <button
          type="button"
          className="btn"
          title={`Load test this ${noun.toLowerCase()}`}
          onClick={() => store().openLoadTest(path)}
        >
          <Gauge size={14} aria-hidden="true" />
          Load test
        </button>
      </div>
    </div>
  )
}

/** The variables a `{{name}}` in these settings resolves to when a request of this collection is sent. */
function useVariables(path: string) {
  const environments = useApp((s) => s.environments)
  const activeEnvironmentId = useApp((s) => s.activeEnvironmentId)
  const collection = useApp((s) => s.collections.find((c) => path === c.path || path.startsWith(`${c.path}/`)))
  return useMemo(
    () => ({
      lookup: variableLookup(environments, activeEnvironmentId, collection),
      options: variableOptions(environments, activeEnvironmentId, collection),
    }),
    [environments, activeEnvironmentId, collection],
  )
}
