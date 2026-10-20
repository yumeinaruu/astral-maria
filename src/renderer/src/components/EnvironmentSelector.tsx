import { ChevronDown, X } from 'lucide-react'
import { GLOBALS_ID } from '../lib/environments'
import { useApp } from '../state/store'
import { MenuButton } from './MenuButton'

/** Tab-strip control that picks the active environment (the same choice as the check in the sidebar). */
export function EnvironmentSelector(): React.JSX.Element {
  const environments = useApp((s) => s.environments)
  const activeId = useApp((s) => s.activeEnvironmentId)
  const notice = useApp((s) => s.environmentNotice)
  const listed = environments.filter((e) => e.id !== GLOBALS_ID)
  const active = listed.find((e) => e.id === activeId)
  const choose = (id: string | null) => () => useApp.getState().setActiveEnvironment(id)

  return (
    <div className="tabstrip-env">
      {notice && (
        <span className="env-notice" role="status" title={notice}>
          <span className="env-notice-text">{notice}</span>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="Dismiss notice"
            onClick={() => useApp.getState().dismissEnvironmentNotice()}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </span>
      )}
      <MenuButton
        label="Environment"
        title={active ? `Environment: ${active.name}` : 'No environment selected'}
        className={`raised-btn env-select${active ? '' : ' env-select-empty'}`}
        align="end"
        items={[
          { label: 'No environment', checked: !active, onSelect: choose(null) },
          ...(listed.length > 0 ? [{ separator: true as const }] : []),
          ...listed.map((e) => ({ label: e.name, checked: e.id === active?.id, onSelect: choose(e.id) })),
        ]}
      >
        <span className="raised-btn-label">{active?.name ?? 'No environment'}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </MenuButton>
    </div>
  )
}
