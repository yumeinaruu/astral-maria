import { ChevronDown, GitBranch, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { SYNC_FETCH_MS, useApp } from '../../state/store'
import { ConfirmDialog } from '../ConfirmDialog'
import { MenuButton } from '../MenuButton'
import { CommitDialog } from './CommitDialog'
import { SetupSyncDialog } from './SetupSyncDialog'

/**
 * The sync part of the status bar: `Set up sync` for a workspace that is not linked; otherwise the branch, how far
 * ahead and behind it is, a dot for uncommitted changes, the last operation's result and the Sync split button.
 */
export function SyncButton(): React.JSX.Element | null {
  const sync = useApp((s) => s.sync)
  const busy = useApp((s) => s.syncBusy)
  const notice = useApp((s) => s.syncNotice)
  const [dialog, setDialog] = useState<'setup' | 'commit-sync' | 'commit' | 'unlink' | null>(null)
  const linked = sync?.linked ?? false

  // The state is read when the bar appears and whenever the window gains focus (files may have changed outside).
  useEffect(() => {
    const refresh = (): void => void useApp.getState().refreshSync()
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  // A linked workspace fetches in the background, so `↓m` shows what is waiting on the remote.
  useEffect(() => {
    if (!linked) return
    const timer = setInterval(() => void useApp.getState().fetchSync(), SYNC_FETCH_MS)
    return () => clearInterval(timer)
  }, [linked])

  if (!sync) return null

  if (!sync.linked) {
    return (
      <>
        <button type="button" className="btn btn-text" onClick={() => setDialog('setup')}>
          <GitBranch size={13} aria-hidden="true" />
          Set up sync
        </button>
        {dialog === 'setup' && <SetupSyncDialog onClose={() => setDialog(null)} />}
      </>
    )
  }

  const merging = sync.merging
  // During a merge the index holds the incoming files: they are not the user's changes.
  const dirty = !merging && sync.changes.length > 0

  async function startSync(): Promise<void> {
    const store = useApp.getState()
    if (store.sync?.merging) {
      store.setConflictsOpen(true)
      return
    }
    const state = await store.prepareSync()
    if (!state) return
    if (state.merging) store.setConflictsOpen(true)
    else if (state.changes.length > 0) setDialog('commit-sync')
    else await store.syncNow(null)
  }

  async function startCommit(): Promise<void> {
    if (await useApp.getState().prepareSync()) setDialog('commit')
  }

  function copyUrl(): void {
    const url = useApp.getState().sync?.remoteUrl
    if (!url) return
    navigator.clipboard.writeText(url).catch(() => useApp.setState({ error: 'Could not copy the remote URL' }))
  }

  return (
    <>
      {notice && (
        <span className="sync-notice" role="status">
          {notice}
        </span>
      )}
      <span className="sync-status" title={sync.remoteUrl ?? undefined}>
        <GitBranch size={13} aria-hidden="true" />
        <span className="sync-branch">{sync.branch ?? 'detached'}</span>
        {(sync.ahead > 0 || sync.behind > 0) && (
          <span
            className="sync-counts"
            title={`${sync.ahead} to push, ${sync.behind} to pull`}
          >{`↑${sync.ahead} ↓${sync.behind}`}</span>
        )}
        {dirty && <span className="sync-dot" role="img" aria-label="Uncommitted changes" title="Uncommitted changes" />}
      </span>
      <span className="sync-split">
        <button
          type="button"
          className="btn btn-text sync-main"
          disabled={busy}
          title={merging ? 'Resolve the conflicts of the merge in progress' : 'Commit, pull and push'}
          onClick={() => void startSync()}
        >
          <RefreshCw size={13} className={busy ? 'spin' : undefined} aria-hidden="true" />
          Sync
        </button>
        <MenuButton
          label="More sync actions"
          menuLabel="Sync"
          className="btn btn-text sync-chevron"
          align="end"
          disabled={busy}
          items={() => [
            { label: 'Pull only', disabled: merging, onSelect: () => void useApp.getState().pullOnly() },
            { label: 'Push only', disabled: merging, onSelect: () => void useApp.getState().pushOnly() },
            { label: 'Commit…', disabled: merging, onSelect: () => void startCommit() },
            { separator: true },
            { label: 'Copy remote URL', disabled: !sync.remoteUrl, onSelect: copyUrl },
            { label: 'Unlink…', danger: true, disabled: merging, onSelect: () => setDialog('unlink') },
          ]}
        >
          <ChevronDown size={13} aria-hidden="true" />
        </MenuButton>
      </span>
      {(dialog === 'commit-sync' || dialog === 'commit') && (
        <CommitDialog mode={dialog === 'commit' ? 'commit' : 'sync'} onClose={() => setDialog(null)} />
      )}
      {dialog === 'unlink' && (
        <ConfirmDialog
          title="Unlink from git"
          message={`The workspace stops syncing with ${sync.remoteUrl ?? 'its remote'}. Its files and git history stay in the folder.`}
          confirmLabel="Unlink"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null)
            void useApp.getState().unlinkRemote()
          }}
        />
      )}
    </>
  )
}
