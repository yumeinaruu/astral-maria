import { useId, useState } from 'react'
import { IDENTITY_MISSING_MESSAGE } from '../../../../shared/syncText'
import { useApp } from '../../state/store'
import { DialogError, IdentityFields, identityComplete, SyncDialog, type Identity } from './SyncDialog'

/**
 * Links the workspace to a repository. Linking a workspace to a remote that already has commits first commits the
 * workspace's files, so a repository without a git identity is asked for one and the link is retried.
 */
export function SetupSyncDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const urlId = useId()
  const hintId = useId()
  const [url, setUrl] = useState('')
  const [needIdentity, setNeedIdentity] = useState(false)
  const [identity, setIdentity] = useState<Identity>({ name: '', email: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = !busy && url.trim() !== '' && (!needIdentity || identityComplete(identity))

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
      }
      const result = await store.linkRemote(url.trim())
      if (result.ok) onClose()
      else if (result.error === IDENTITY_MISSING_MESSAGE) setNeedIdentity(true)
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SyncDialog title="Set up sync" busy={busy} onClose={onClose} onSubmit={() => void submit()}>
      <div className="sync-field">
        <label htmlFor={urlId} className="sync-label">
          Repository URL
        </label>
        <input
          id={urlId}
          className="text-input mono"
          placeholder="git@github.com:you/repo.git"
          spellCheck={false}
          autoComplete="off"
          aria-describedby={hintId}
          disabled={busy}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <p id={hintId} className="sync-hint">
          Uses the system git with your SSH keys and credential helper. The remote can be empty or already hold a
          workspace.
        </p>
      </div>
      {needIdentity && <IdentityFields value={identity} onChange={setIdentity} disabled={busy} />}
      <DialogError message={error} />
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          Link
        </button>
      </div>
    </SyncDialog>
  )
}
