import { useId, useState } from 'react'
import { useApp } from '../../state/store'
import { SyncDialog } from './SyncDialog'

/**
 * "Open from Git": asks for a repository URL; the folder picker then chooses an empty folder to clone into, and the
 * clone opens as the workspace. Errors go to the error banner, which the gate shows too.
 */
export function OpenFromGitDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const urlId = useId()
  const hintId = useId()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(): Promise<void> {
    const text = url.trim()
    if (busy || text === '') return
    setBusy(true)
    try {
      const result = await useApp.getState().openFromGit(text)
      // A cancelled folder picker keeps the dialog for another try; otherwise it closes (errors are in the banner).
      if (result !== 'cancelled') onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <SyncDialog title="Open from Git" busy={busy} onClose={onClose} onSubmit={() => void submit()}>
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
          Next, choose an empty folder to clone into. Uses the system git with your SSH keys and credential helper.
        </p>
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || url.trim() === ''}>
          Clone
        </button>
      </div>
    </SyncDialog>
  )
}
