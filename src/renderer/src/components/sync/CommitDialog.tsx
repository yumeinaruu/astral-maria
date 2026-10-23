import { useId, useState } from 'react'
import { defaultCommitMessage, IDENTITY_MISSING_MESSAGE } from '../../../../shared/syncText'
import type { SyncChange } from '../../../../shared/types'
import { useApp } from '../../state/store'
import { DialogError, IdentityFields, identityComplete, SyncDialog, type Identity } from './SyncDialog'

const MARKS: Record<SyncChange['kind'], { mark: string; label: string }> = {
  added: { mark: '+', label: 'Added' },
  modified: { mark: '~', label: 'Changed' },
  deleted: { mark: '−', label: 'Deleted' },
  renamed: { mark: '→', label: 'Renamed' },
}

/**
 * The changes about to be committed and an editable message. `sync` commits and syncs (opened by Sync); `commit`
 * only commits (opened by Commit…). Asks for the git identity first when the repository has none.
 */
export function CommitDialog({ mode, onClose }: { mode: 'sync' | 'commit'; onClose(): void }): React.JSX.Element {
  const messageId = useId()
  const sync = useApp((s) => s.sync)
  const changes = sync?.changes ?? []
  const [message, setMessage] = useState(() => defaultCommitMessage(changes))
  const [needIdentity, setNeedIdentity] = useState(() => sync?.identity === null)
  const [identity, setIdentity] = useState<Identity>({ name: '', email: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit =
    !busy && message.trim() !== '' && changes.length > 0 && (!needIdentity || identityComplete(identity))

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const store = useApp.getState()
    try {
      if (needIdentity) {
        const saved = await store.setGitIdentity(identity.name.trim(), identity.email.trim())
        if (!saved.ok) {
          setError(saved.error)
          return
        }
        setNeedIdentity(false)
      }
      const text = message.trim()
      const result =
        mode === 'sync'
          ? await store.syncNow(text, { inline: true })
          : await store.commitChanges(text, { inline: true })
      if (result.ok) {
        onClose()
      } else if (result.error === IDENTITY_MISSING_MESSAGE) {
        setNeedIdentity(true)
      } else {
        // The commit may have been made before a later step failed: the list is stale, so the banner reports it.
        onClose()
        useApp.setState({ error: result.error })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <SyncDialog
      title="Commit changes"
      className="commit-dialog"
      busy={busy}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {needIdentity && <IdentityFields value={identity} onChange={setIdentity} disabled={busy} />}
      {changes.length === 0 ? (
        <p className="sync-hint">There are no changes to commit.</p>
      ) : (
        <ul className="commit-changes" aria-label="Changes">
          {changes.map((c) => (
            <li key={c.path} className={`commit-change commit-${c.kind}`} title={c.path}>
              <span className="commit-mark" title={MARKS[c.kind].label} aria-label={`${MARKS[c.kind].label}:`}>
                {MARKS[c.kind].mark}
              </span>
              <span className="commit-label">{c.label}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="sync-field">
        <label htmlFor={messageId} className="sync-label">
          Commit message
        </label>
        <textarea
          id={messageId}
          className="sync-textarea"
          rows={3}
          spellCheck={false}
          disabled={busy}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            // Enter adds a line; Cmd/Ctrl+Enter commits.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void submit()
            }
          }}
        />
      </div>
      <DialogError message={error} />
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          {mode === 'sync' ? 'Commit and sync' : 'Commit'}
        </button>
      </div>
    </SyncDialog>
  )
}
