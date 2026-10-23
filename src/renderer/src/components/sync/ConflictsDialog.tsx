import { Check, GitMerge } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { SyncChoice, SyncConflictItem } from '../../../../shared/types'
import { useApp } from '../../state/store'
import { ConfirmDialog } from '../ConfirmDialog'
import { DialogError, SyncDialog } from './SyncDialog'

type Side = 'ours' | 'theirs'

const NO_CONFLICTS: SyncConflictItem[] = []

/** While a merge is in progress: the way back to the Conflicts dialog. */
export function MergeBanner(): React.JSX.Element | null {
  const merging = useApp((s) => s.sync?.merging ?? false)
  const left = useApp((s) => s.sync?.conflicts.length ?? 0)
  const open = useApp((s) => s.conflictsOpen)
  if (!merging || open) return null
  return (
    <div className="banner banner-merge" role="region" aria-label="Merge in progress">
      <GitMerge size={14} aria-hidden="true" />
      <span className="banner-text">
        {left === 0
          ? 'Every conflict is resolved. Finish the merge to complete it.'
          : `A merge is in progress: ${left} ${left === 1 ? 'conflict' : 'conflicts'} to resolve.`}
      </span>
      <button type="button" className="btn" onClick={() => useApp.getState().setConflictsOpen(true)}>
        Resolve conflicts
      </button>
    </div>
  )
}

/**
 * The items a merge could not settle, one row each, resolved one by one. `Finish` (`Finish and push` after a Sync)
 * commits the merge once nothing is left; `Abort merge` returns to the state before it.
 */
export function ConflictsDialog(): React.JSX.Element {
  const conflicts = useApp((s) => s.sync?.conflicts ?? NO_CONFLICTS)
  const merging = useApp((s) => s.sync?.merging ?? false)
  const origin = useApp((s) => s.mergeOrigin)
  // Resolved items leave `conflicts`; the dialog keeps showing them, marked resolved.
  const [seen, setSeen] = useState<SyncConflictItem[]>(conflicts)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmAbort, setConfirmAbort] = useState(false)

  useEffect(() => {
    setSeen((prev) => {
      const known = new Set(prev.map((i) => i.id))
      const added = conflicts.filter((i) => !known.has(i.id))
      return added.length === 0 ? prev : [...prev, ...added]
    })
  }, [conflicts])

  const open = new Map(conflicts.map((i) => [i.id, i]))
  const close = (): void => useApp.getState().setConflictsOpen(false)

  async function run(work: () => Promise<{ ok: true } | { ok: false; error: string }>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await work()
      if (!result.ok) setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  const resolve = (id: string, choice: SyncChoice): Promise<void> =>
    run(() => useApp.getState().resolveConflict(id, choice))

  const canFinish = !busy && merging && conflicts.length === 0

  return (
    <>
      <SyncDialog title="Resolve conflicts" className="conflicts-dialog" busy={busy} onClose={close}>
        <p className="sync-hint">
          Both sides changed these. Choose what to keep for each; nothing is pushed until you finish.
        </p>
        <ul className="conflict-list">
          {seen.map((item) => {
            const current = open.get(item.id)
            return (
              <li key={item.id}>
                <div role="group" aria-label={item.label} className="conflict-item">
                  <div className="conflict-head">
                    <span className="conflict-label" title={item.id}>
                      {item.label}
                    </span>
                    {!current && (
                      <span className="conflict-resolved">
                        <Check size={14} aria-hidden="true" />
                        Resolved
                      </span>
                    )}
                  </div>
                  {current && (
                    <ConflictChoices
                      item={current}
                      busy={busy}
                      onResolve={(choice) => void resolve(current.id, choice)}
                      onOpen={() => void run(() => useApp.getState().openConflictInEditor(current.id))}
                    />
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        <DialogError message={error} />
        <div className="dialog-actions conflicts-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirmAbort(true)}>
            Abort merge
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canFinish}
            onClick={() => void run(() => useApp.getState().finishMerge())}
          >
            {origin === 'sync' ? 'Finish and push' : 'Finish'}
          </button>
        </div>
      </SyncDialog>
      {confirmAbort && (
        <ConfirmDialog
          title="Abort the merge?"
          message="The workspace goes back to how it was before the merge. Your earlier commits are kept and nothing is pushed."
          confirmLabel="Abort merge"
          onCancel={() => setConfirmAbort(false)}
          onConfirm={() => {
            setConfirmAbort(false)
            void run(() => useApp.getState().abortMerge())
          }}
        />
      )}
    </>
  )
}

function ConflictChoices({
  item,
  busy,
  onResolve,
  onOpen,
}: {
  item: SyncConflictItem
  busy: boolean
  onResolve(choice: SyncChoice): void
  onOpen(): void
}): React.JSX.Element {
  if (item.kind === 'fields') return <FieldChoices item={item} busy={busy} onResolve={onResolve} />
  if (item.kind === 'file') {
    return (
      <div className="conflict-row">
        <span className="conflict-note">This file cannot be merged field by field.</span>
        <div className="conflict-buttons">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onResolve('ours')}>
            Keep mine
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onResolve('theirs')}>
            Keep theirs
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onOpen}>
            Open in editor
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onResolve('edited')}>
            Use edited file
          </button>
        </div>
      </div>
    )
  }
  // deleted_remote: `ours` keeps it, `theirs` deletes it; deleted_local the other way round.
  const remote = item.kind === 'deleted_remote'
  const keep: Side = remote ? 'ours' : 'theirs'
  const remove: Side = remote ? 'theirs' : 'ours'
  return (
    <div className="conflict-row">
      <span className="conflict-note">{remote ? 'Deleted on the remote' : 'Deleted here'}</span>
      <div className="conflict-buttons">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onResolve(keep)}>
          {remote ? 'Keep mine' : 'Keep theirs'}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onResolve(remove)}>
          Delete
        </button>
      </div>
    </div>
  )
}

function FieldChoices({
  item,
  busy,
  onResolve,
}: {
  item: SyncConflictItem
  busy: boolean
  onResolve(choice: SyncChoice): void
}): React.JSX.Element {
  const group = useId()
  const fields = item.fields ?? []
  const [choices, setChoices] = useState<Record<string, Side>>({})
  const all = (side: Side): void => setChoices(Object.fromEntries(fields.map((f) => [f.path, side])))
  const complete = fields.length > 0 && fields.every((f) => choices[f.path] !== undefined)

  return (
    <div className="conflict-fields">
      <table className="conflict-table">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Yours</th>
            <th scope="col">Theirs</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f, i) => (
            <tr key={f.path}>
              <th scope="row" className="conflict-field">
                {f.label}
              </th>
              {(['ours', 'theirs'] as const).map((side) => (
                <td key={side}>
                  <label className="conflict-value">
                    <input
                      type="radio"
                      name={`${group}-${i}`}
                      aria-label={`${f.label}: ${side === 'ours' ? 'yours' : 'theirs'}`}
                      disabled={busy}
                      checked={choices[f.path] === side}
                      onChange={() => setChoices((c) => ({ ...c, [f.path]: side }))}
                    />
                    <span className="conflict-text mono">{side === 'ours' ? f.ours : f.theirs}</span>
                  </label>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="conflict-buttons">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => all('ours')}>
          All mine
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => all('theirs')}>
          All theirs
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || !complete}
          onClick={() => onResolve({ fields: choices })}
        >
          Apply
        </button>
      </div>
    </div>
  )
}
