import { useState } from 'react'
import { GLOBALS_ID } from '../lib/environments'
import { useApp } from '../state/store'
import { EnvironmentEditor } from './EnvironmentEditor'

/** Top-bar control: pick the active environment and open the environment editor. */
export function EnvironmentSelector(): React.JSX.Element {
  const environments = useApp((s) => s.environments)
  const activeId = useApp((s) => s.activeEnvironmentId)
  const notice = useApp((s) => s.environmentNotice)
  const [editing, setEditing] = useState(false)

  return (
    <div className="env-selector">
      {notice && (
        <span className="env-notice" role="status">
          {notice}
          <button
            type="button"
            className="btn btn-ghost env-notice-dismiss"
            aria-label="Dismiss notice"
            onClick={() => useApp.getState().dismissEnvironmentNotice()}
          >
            ×
          </button>
        </span>
      )}
      <label className="env-label">
        <span className="muted">Environment</span>
        <select
          className="text-input"
          value={activeId ?? ''}
          onChange={(e) => useApp.getState().setActiveEnvironment(e.target.value || null)}
        >
          <option value="">No environment</option>
          {environments
            .filter((e) => e.id !== GLOBALS_ID)
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
        </select>
      </label>
      <button
        type="button"
        className="btn btn-ghost"
        aria-label="Manage environments"
        title="Manage environments"
        onClick={() => setEditing(true)}
      >
        ⚙
      </button>
      {editing && <EnvironmentEditor onClose={() => setEditing(false)} />}
    </div>
  )
}
