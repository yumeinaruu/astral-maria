import { ChevronRight, Save } from 'lucide-react'
import type { CollectionTree, TreeNode } from '../../../../shared/types'
import { shortcut } from '../../lib/platform'
import { useApp } from '../../state/store'

/** Names of the collection and folders above `path`, top first. */
export function trailOf(collections: CollectionTree[], path: string): string[] {
  const walk = (nodes: TreeNode[], trail: string[]): string[] | null => {
    for (const n of nodes) {
      if (n.path === path) return trail
      if (n.kind === 'folder' && path.startsWith(`${n.path}/`)) return walk(n.children, [...trail, n.name])
    }
    return null
  }
  for (const c of collections) {
    if (path.startsWith(`${c.path}/`)) return walk(c.children, [c.name]) ?? [c.name]
  }
  return []
}

/** The collection path ending in the editable request name, and the save area. */
export function Breadcrumb({ path, name }: { path: string; name: string }): React.JSX.Element {
  const trail = useApp((s) => trailOf(s.collections, path).join('\u0000'))
  const save = useApp((s) => s.saves[path])
  const store = useApp.getState

  return (
    <div className="crumb-row">
      <nav className="crumbs" aria-label="Request location">
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
          key={name}
          className="crumb-name"
          type="text"
          aria-label="Request name"
          title="Rename"
          defaultValue={name}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') {
              e.currentTarget.value = name
              e.currentTarget.blur()
            }
          }}
          onBlur={(e) => {
            const next = e.currentTarget.value.trim()
            if (next && next !== name) void store().rename(path, next)
            else e.currentTarget.value = name
          }}
        />
      </nav>

      <div className="save-area">
        <span
          role="status"
          className={`save-status${save?.state === 'failed' || save?.state === 'conflict' ? ' save-status-failed' : ''}${save === undefined ? ' sr-only' : ''}`}
          title={save?.error}
        >
          {save === undefined
            ? 'Saved'
            : save.state === 'failed'
              ? `Save failed: ${save.error ?? 'unknown error'}`
              : save.state === 'conflict'
                ? 'Not saved: changed on disk'
                : 'Saving…'}
        </span>
        {save?.state === 'conflict' && (
          <div className="conflict-inline" role="alert" aria-label="Changed on disk">
            <span className="sr-only">
              Changed on disk. This request&apos;s file was changed outside Astral Maria after it was opened, so your
              edits were not saved.
            </span>
            <button type="button" className="btn btn-sm" onClick={() => void store().overwriteOnDisk(path)}>
              Overwrite
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void store().reloadFromDisk(path)}>
              Reload from disk
            </button>
          </div>
        )}
        <button
          type="button"
          className="btn-text save-btn"
          disabled={save === undefined || save.state === 'conflict'}
          title={`Save (${shortcut('S')})`}
          onClick={() => void store().saveNow(path)}
        >
          <Save size={14} aria-hidden="true" />
          Save
        </button>
      </div>
    </div>
  )
}
