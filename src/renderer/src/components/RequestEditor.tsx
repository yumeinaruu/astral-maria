import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { RequestItem } from '../../../shared/types'
import { variableLookup, variableOptions } from '../lib/variables'
import { useApp } from '../state/store'
import { useUi, SHARE_MAX, SHARE_MIN, type PaneLayout } from '../state/ui'
import { KeyValueTable } from './KeyValueTable'
import { AuthPanel } from './request/AuthPanel'
import { BodyPanel } from './request/BodyPanel'
import { Breadcrumb } from './request/Breadcrumb'
import { ScriptsPanel } from './request/ScriptsPanel'
import { SectionNav, type Section } from './request/SectionNav'
import { UrlBar } from './request/UrlBar'
import { ResponseViewer } from './ResponseViewer'
import { VariableOptionsContext, VariablesContext } from './VarInput'

/** Below this width the request sub-sections collapse into a dropdown. */
const COMPACT_WIDTH = 560

export function RequestEditor({ path }: { path: string }): React.JSX.Element {
  const draft = useApp((s) => s.drafts[path])
  const layout = useUi((s) => s.layout)
  const share = useUi((s) => s.responseShare[s.layout])
  const [section, setSection] = useState<Section>('Params')
  const splitRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const compact = useNarrow(paneRef, COMPACT_WIDTH, draft !== undefined)
  const sectionId = useId()
  const { lookup, options } = useVariables(path)

  // Cmd/Ctrl+S saves the open request wherever the focus is. Captured on the window, so an input that stops the key's
  // propagation (inline rename, CodeMirror, the completion menu) cannot swallow it.
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

  if (!draft) return <p className="muted editor-loading">Loading request…</p>

  const store = useApp.getState
  const edit = (patch: Partial<RequestItem>): void => store().editDraft(path, (r) => ({ ...r, ...patch }))
  // Without scripts the field is left out of the request, not stored empty.
  const editScripts = (scripts: RequestItem['scripts']): void =>
    store().editDraft(path, ({ scripts: _old, ...rest }) => (scripts ? { ...rest, scripts } : rest))

  function onKeyDown(e: React.KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (store().responses[path]?.state !== 'sending') void store().send(path)
    }
  }

  return (
    <VariablesContext.Provider value={lookup}>
      <VariableOptionsContext.Provider value={options}>
        <div className="request-editor" onKeyDown={onKeyDown}>
          <Breadcrumb path={path} name={draft.name} />
          <UrlBar path={path} draft={draft} edit={edit} />
          <div className={`request-split split-${layout}`} ref={splitRef}>
            <div className="request-pane" ref={paneRef}>
              <SectionNav
                idBase={sectionId}
                section={section}
                onSelect={setSection}
                draft={draft}
                compact={compact}
                onCookies={() => store().setResponseView(path, { tab: 'cookies' })}
              />
              <div
                {...(compact
                  ? { role: 'region', 'aria-label': section }
                  : { role: 'tabpanel', id: `${sectionId}-panel`, 'aria-labelledby': `${sectionId}-${section}` })}
                className="section-panel"
              >
                {section === 'Params' && (
                  <KeyValueTable
                    noun="param"
                    title="Query Params"
                    rows={draft.params}
                    onChange={(params) => edit({ params })}
                  />
                )}
                {section === 'Headers' && (
                  <KeyValueTable
                    noun="header"
                    title="Headers"
                    rows={draft.headers}
                    onChange={(headers) => edit({ headers })}
                  />
                )}
                {section === 'Body' && <BodyPanel draft={draft} edit={edit} />}
                {section === 'Authorization' && <AuthPanel draft={draft} edit={edit} path={path} />}
                {section === 'Scripts' && <ScriptsPanel scripts={draft.scripts} onChange={editScripts} />}
              </div>
            </div>

            <Splitter
              layout={layout}
              value={share}
              containerRef={splitRef}
              onChange={(v) => useUi.getState().setResponseShare(layout, v)}
            />
            <section className="response-slot" aria-label="Response" style={{ flexBasis: `${share * 100}%` }}>
              <ResponseViewer path={path} />
            </section>
          </div>
        </div>
      </VariableOptionsContext.Provider>
    </VariablesContext.Provider>
  )
}

/**
 * The variables of the request's collection, the active environment and the globals, as sending resolves them: a
 * lookup for highlighting and the list offered by the `{{` completion.
 */
function useVariables(path: string) {
  const environments = useApp((s) => s.environments)
  const activeEnvironmentId = useApp((s) => s.activeEnvironmentId)
  const collection = useApp((s) => s.collections.find((c) => path.startsWith(`${c.path}/`)))
  return useMemo(
    () => ({
      lookup: variableLookup(environments, activeEnvironmentId, collection),
      options: variableOptions(environments, activeEnvironmentId, collection),
    }),
    [environments, activeEnvironmentId, collection],
  )
}

/** True while the element is narrower than `width`; false where nothing can be measured. */
function useNarrow(ref: React.RefObject<HTMLElement | null>, width: number, mounted: boolean): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setNarrow(entry.contentRect.width < width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, width, mounted])
  return narrow
}

const KEY_STEP = 0.05

interface SplitterProps {
  layout: PaneLayout
  /** The share (0-1) of the split area taken by the response. */
  value: number
  containerRef: React.RefObject<HTMLDivElement | null>
  onChange(value: number): void
}

/** The draggable and keyboard-resizable divider between the request and the response. */
function Splitter({ layout, value, containerRef, onChange }: SplitterProps): React.JSX.Element {
  const side = layout === 'side'
  const clamp = (v: number): number => Math.min(SHARE_MAX, Math.max(SHARE_MIN, v))

  function onPointerMove(e: React.PointerEvent): void {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    if (side && rect.width > 0) onChange(clamp((rect.right - e.clientX) / rect.width))
    else if (!side && rect.height > 0) onChange(clamp((rect.bottom - e.clientY) / rect.height))
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    // The divider moves towards the request when the response grows.
    const grow = side ? 'ArrowLeft' : 'ArrowUp'
    const shrink = side ? 'ArrowRight' : 'ArrowDown'
    const next =
      e.key === grow
        ? value + KEY_STEP
        : e.key === shrink
          ? value - KEY_STEP
          : e.key === 'Home'
            ? SHARE_MAX
            : e.key === 'End'
              ? SHARE_MIN
              : null
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    onChange(clamp(next))
  }

  return (
    <div
      role="separator"
      // A side-by-side split has a vertical divider line.
      aria-orientation={side ? 'vertical' : 'horizontal'}
      aria-label="Resize response"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={Math.round(SHARE_MIN * 100)}
      aria-valuemax={Math.round(SHARE_MAX * 100)}
      tabIndex={0}
      className="splitter"
      onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      onKeyDown={onKeyDown}
    />
  )
}
