import type { RequestItem } from '../../../../shared/types'
import { Dropdown } from '../Dropdown'
import { hasScripts } from './ScriptsPanel'

export const SECTIONS = ['Params', 'Authorization', 'Headers', 'Body', 'Scripts'] as const
export type Section = (typeof SECTIONS)[number]

/** Whether a section holds something, for the dot marker. */
export function configured(draft: RequestItem): Record<Section, boolean> {
  return {
    Params: draft.params.some((p) => p.enabled),
    Authorization: draft.auth.type !== 'none' && draft.auth.type !== 'inherit',
    Headers: draft.headers.some((h) => h.enabled),
    Body: draft.body.mode !== 'none',
    Scripts: hasScripts(draft.scripts),
  }
}

interface Props {
  idBase: string
  section: Section
  onSelect(section: Section): void
  draft: RequestItem
  /** A dropdown instead of the pill tabs (narrow pane). */
  compact: boolean
  onCookies(): void
}

/** The request sub-sections: pill tabs, or one dropdown button when the pane is narrow. */
export function SectionNav({ idBase, section, onSelect, draft, compact, onCookies }: Props): React.JSX.Element {
  const marks = configured(draft)
  const headerCount = draft.headers.filter((h) => h.enabled).length

  function onKeyDown(e: React.KeyboardEvent, index: number): void {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const target = SECTIONS[(index + step + SECTIONS.length) % SECTIONS.length]!
    onSelect(target)
    document.getElementById(`${idBase}-${target}`)?.focus()
  }

  return (
    <div className="section-row">
      {compact ? (
        <Dropdown
          label="Request section"
          className="section-dropdown"
          value={section}
          options={SECTIONS.map((s) => ({ value: s, label: s, marker: marks[s] }))}
          onChange={onSelect}
        />
      ) : (
        <div className="pill-tabs" role="tablist" aria-label="Request sections">
          {SECTIONS.map((name, i) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`${idBase}-${name}`}
              aria-selected={section === name}
              aria-controls={`${idBase}-panel`}
              tabIndex={section === name ? 0 : -1}
              className="pill-tab"
              onClick={() => onSelect(name)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {name}
              {name === 'Headers' && headerCount > 0 && <span className="pill-count"> ({headerCount})</span>}
              {(name === 'Body' || name === 'Authorization' || name === 'Scripts') && marks[name] && (
                <>
                  <span className="config-dot" aria-hidden="true" />
                  <span className="sr-only"> (configured)</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      <button type="button" className="btn-text cookies-link" onClick={onCookies}>
        Cookies
      </button>
    </div>
  )
}
