import { useState } from 'react'
import { useApp } from '../state/store'
import { ConfirmDialog } from './ConfirmDialog'
import { MethodBadge } from './MethodBadge'

export function tabDomId(path: string): string {
  return `request-tab-${path.replace(/\s/g, '_')}`
}

function basename(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.request\.json$/, '')
}

/** The strip of open requests; a dot marks tabs with changes that are not on disk yet. */
export function RequestTabs(): React.JSX.Element {
  const openTabs = useApp((s) => s.openTabs)
  const activePath = useApp((s) => s.activePath)
  const drafts = useApp((s) => s.drafts)
  const saves = useApp((s) => s.saves)
  const [closing, setClosing] = useState<string | null>(null)

  function close(path: string): void {
    if (saves[path]?.state === 'failed') setClosing(path)
    else useApp.getState().closeTab(path)
  }

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
    useApp.getState().openRequest(path)
    document.getElementById(tabDomId(path))?.focus()
  }

  const closingName = closing === null ? '' : (drafts[closing]?.name ?? basename(closing))

  return (
    <div className="request-tabs" role="tablist" aria-label="Open requests">
      {openTabs.map((tab, i) => {
        const draft = drafts[tab.path]
        const active = tab.path === activePath
        const name = draft?.name ?? basename(tab.path)
        return (
          <div key={tab.path} role="presentation" className={`request-tab${active ? ' request-tab-active' : ''}`}>
            <button
              type="button"
              role="tab"
              id={tabDomId(tab.path)}
              className="request-tab-main"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tab.path}
              onClick={() => useApp.getState().openRequest(tab.path)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {draft && <MethodBadge method={draft.method} />}
              <span className="request-tab-name">{name}</span>
              {saves[tab.path] && (
                <>
                  <span className="dirty-dot" aria-hidden="true" />
                  <span className="sr-only">Unsaved changes</span>
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-ghost request-tab-close"
              aria-label={`Close ${name}`}
              onClick={() => close(tab.path)}
            >
              ×
            </button>
          </div>
        )
      })}
      {closing !== null && (
        <ConfirmDialog
          title="Unsaved changes"
          message={`The latest changes to "${closingName}" could not be saved${
            saves[closing]?.error ? ` (${saves[closing]?.error})` : ''
          }. Close the tab and discard them?`}
          confirmLabel="Close and discard"
          onConfirm={() => {
            const path = closing
            setClosing(null)
            useApp.getState().closeTab(path)
          }}
          onCancel={() => setClosing(null)}
        />
      )}
    </div>
  )
}
