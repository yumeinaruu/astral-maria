import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { Environment } from '../../../shared/types'
import {
  GLOBALS_ID,
  GLOBALS_NAME,
  blankRow,
  duplicateOf,
  fingerprint,
  nameProblem,
  newId,
  rowProblems,
  toDraft,
  toEnvironment,
  uniqueName,
  type Draft,
  type Row,
} from '../lib/environments'
import { useApp } from '../state/store'
import { LoadErrorsBanner } from './Banners'
import { ConfirmDialog } from './ConfirmDialog'

const FOCUSABLE = 'button, input, select, [tabindex]:not([tabindex="-1"])'

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The stored environment, or the empty globals set that exists before its first save. */
function lookup(id: string): Environment | undefined {
  const found = useApp.getState().environments.find((e) => e.id === id)
  if (found || id !== GLOBALS_ID) return found
  return { id: GLOBALS_ID, name: GLOBALS_NAME, variables: [] }
}

function printOf(draft: Draft): string {
  return fingerprint(toEnvironment(draft))
}

interface Props {
  onClose(): void
}

/** Modal editor of the workspace's environments: a list on the left, the variables of the selected one on the right. */
export function EnvironmentEditor({ onClose }: Props): React.JSX.Element {
  const titleId = useId()
  const environments = useApp((s) => s.environments)
  const loadErrors = useApp((s) => s.environmentErrors)
  const dialogRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  /** Changes whenever another environment is shown, so a late save result cannot touch the new draft. */
  const selection = useRef(0)

  const [draft, setDraft] = useState<Draft>(() => {
    const start = lookup(useApp.getState().activeEnvironmentId ?? GLOBALS_ID) ?? lookup(GLOBALS_ID)!
    return toDraft(start)
  })
  const [baseline, setBaseline] = useState(() => printOf(draft))
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** Set while the unsaved-changes dialog waits; `run` continues with what the user wanted to do. */
  const [leaving, setLeaving] = useState<{ run(): void } | null>(null)

  const dirty = draft.isNew || printOf(draft) !== baseline
  const isGlobals = draft.id === GLOBALS_ID
  const stored = environments.find((e) => e.id === draft.id)
  const storedPrint = stored ? fingerprint(stored) : null
  const rowErrors = rowProblems(draft.rows)
  const otherNames = [
    ...environments.filter((e) => e.id !== draft.id).map((e) => e.name),
    ...(draft.id === GLOBALS_ID || environments.some((e) => e.id === GLOBALS_ID) ? [] : [GLOBALS_NAME]),
  ]
  const nameError = isGlobals ? null : nameProblem(draft.name, otherNames)
  const invalid = rowErrors.size > 0 || nameError !== null
  const changedOnDisk = dirty && !draft.isNew && storedPrint !== null && storedPrint !== baseline
  const missingOnDisk = !draft.isNew && !isGlobals && stored === undefined && !busy

  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => {
      mounted.current = false
      previous?.focus()
    }
  }, [])

  function show(env: Environment, isNew = false): void {
    selection.current++
    setDraft(toDraft(env, isNew))
    setBaseline(fingerprint(env))
    setRevealed(new Set())
    setSaveError(null)
  }

  // A clean form follows the disk; a dirty one is kept (and flagged) so nothing is overwritten silently.
  useEffect(() => {
    if (busy || draft.isNew || dirty) return
    if (stored && storedPrint !== baseline) show(stored)
    else if (missingOnDisk) show(lookup(GLOBALS_ID)!)
  })

  async function save(): Promise<boolean> {
    if (busy || !dirty || invalid) return false
    const env = toEnvironment(draft)
    const mine = selection.current
    setBusy(true)
    setSaveError(null)
    try {
      const applied = await useApp.getState().saveEnvironment(env)
      if (!mounted.current || !applied || mine !== selection.current) return applied
      setDraft((d) => ({ ...d, name: env.name, isNew: false }))
      setBaseline(fingerprint(env))
      return true
    } catch (e) {
      if (mounted.current && mine === selection.current) setSaveError(messageOf(e))
      return false
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  /** Runs `next` now, or after the user decided what to do with unsaved changes. */
  function leave(next: () => void): void {
    if (busy) return
    if (dirty) setLeaving({ run: next })
    else next()
  }

  function pick(id: string): void {
    if (id === draft.id) return
    leave(() => {
      const env = lookup(id)
      if (env) show(env)
    })
  }

  function create(): void {
    leave(() => {
      const names = useApp.getState().environments.map((e) => e.name)
      show({ id: newId(), name: uniqueName('New environment', [...names, GLOBALS_NAME]), variables: [] }, true)
    })
  }

  function duplicate(): void {
    const sourceId = draft.id
    leave(() => {
      const source = lookup(sourceId)
      if (!source) return
      const names = [...useApp.getState().environments.map((e) => e.name), GLOBALS_NAME]
      show(duplicateOf(source, uniqueName(`${source.name} copy`, names), newId()), true)
    })
  }

  async function remove(): Promise<void> {
    setConfirmDelete(false)
    const mine = selection.current
    setBusy(true)
    setSaveError(null)
    try {
      const applied = await useApp.getState().removeEnvironment(draft.id)
      if (applied && mounted.current && mine === selection.current) show(lookup(GLOBALS_ID)!)
    } catch (e) {
      if (mounted.current && mine === selection.current) setSaveError(messageOf(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  function requestClose(): void {
    if (!busy) leave(onClose)
  }

  function updateRow(uid: number, patch: Partial<Row>): void {
    setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)) }))
  }

  function setSecret(row: Row, secret: boolean): void {
    if (!secret && row.locked) {
      updateRow(row.uid, {
        secret: false,
        locked: undefined,
        note: 'The value that could not be decrypted is removed when you save.',
      })
    } else if (!secret) {
      updateRow(row.uid, { secret: false, note: undefined })
    } else if (row.value === '') {
      updateRow(row.uid, { secret: true, note: undefined })
    } else if (!row.currentValue) {
      updateRow(row.uid, {
        secret: true,
        value: '',
        currentValue: row.value,
        note: 'Shared value moved to the current value.',
      })
    } else {
      updateRow(row.uid, {
        secret: true,
        value: '',
        note: 'Shared value removed; the existing current value was kept.',
      })
    }
  }

  function toggleReveal(uid: number): void {
    setRevealed((r) => {
      const next = new Set(r)
      if (!next.delete(uid)) next.add(uid)
      return next
    })
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      requestClose()
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Tab') {
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
        (el) => !el.matches(':disabled'),
      )
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === dialogRef.current)) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first?.focus()
      }
    }
  }

  const listed: { id: string; name: string; unsaved: boolean }[] = [
    { id: GLOBALS_ID, name: GLOBALS_NAME, unsaved: false },
    ...environments.filter((e) => e.id !== GLOBALS_ID).map((e) => ({ id: e.id, name: e.name, unsaved: false })),
  ]
  if (!listed.some((e) => e.id === draft.id)) listed.push({ id: draft.id, name: draft.name, unsaved: true })
  const shownName = (entry: { id: string; name: string }): string => (entry.id === draft.id ? draft.name : entry.name)

  return (
    <>
      <div className="dialog-backdrop">
        <div
          ref={dialogRef}
          className="dialog env-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <h2 id={titleId} className="dialog-title">
            Environments
          </h2>
          <LoadErrorsBanner errors={loadErrors} />
          <fieldset className="env-body" disabled={busy}>
            <div className="env-list-pane">
              <ul className="env-list" aria-label="Environments">
                {listed.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`env-list-item${entry.id === draft.id ? ' env-list-item-selected' : ''}`}
                      aria-current={entry.id === draft.id ? 'true' : undefined}
                      onClick={() => pick(entry.id)}
                    >
                      {shownName(entry) || 'Unnamed'}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn" onClick={create}>
                New environment
              </button>
            </div>
            <div className="env-edit-pane">
              <div className="env-edit-header">
                {isGlobals ? (
                  <h3 className="env-name-heading">{GLOBALS_NAME}</h3>
                ) : (
                  <div className="env-name-field">
                    <input
                      className="text-input"
                      aria-label="Environment name"
                      aria-invalid={nameError ? true : undefined}
                      aria-describedby={nameError ? 'env-name-problem' : undefined}
                      value={draft.name}
                      spellCheck={false}
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    />
                    {nameError && (
                      <span id="env-name-problem" className="env-problem">
                        {nameError}
                      </span>
                    )}
                  </div>
                )}
                {draft.isNew && <span className="muted">Not saved yet</span>}
                <span className="env-edit-actions">
                  <button
                    type="button"
                    className="btn"
                    title="Copies the variables. Secret values are not copied, only their keys with empty values."
                    onClick={duplicate}
                  >
                    Duplicate
                  </button>
                  {!isGlobals && !draft.isNew && (
                    <button type="button" className="btn" onClick={() => setConfirmDelete(true)}>
                      Delete environment
                    </button>
                  )}
                </span>
              </div>
              <div className="env-table-wrap">
                <table className="kv-table env-table">
                  <thead>
                    <tr>
                      <th scope="col">Variable</th>
                      <th scope="col">Shared value</th>
                      <th scope="col">Current value</th>
                      <th scope="col" className="kv-check">
                        Secret
                      </th>
                      <th scope="col" className="kv-check">
                        Enabled
                      </th>
                      <th scope="col" className="kv-remove">
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.rows.map((row, i) => {
                      const n = i + 1
                      const problem = rowErrors.get(row.uid)
                      // Until a new value is typed: the stored one cannot be decrypted here, so there is nothing to reveal.
                      const locked = row.secret && row.locked === true && !row.currentValue
                      const shown = revealed.has(row.uid) && !locked
                      const type = row.secret && !shown ? 'password' : 'text'
                      return (
                        <tr key={row.uid} className={row.enabled ? undefined : 'kv-disabled'}>
                          <td>
                            <input
                              className="text-input kv-input mono"
                              aria-label={`Variable name ${n}`}
                              aria-invalid={problem ? true : undefined}
                              aria-describedby={problem ? `env-row-${row.uid}-problem` : undefined}
                              value={row.key}
                              spellCheck={false}
                              onChange={(e) => updateRow(row.uid, { key: e.target.value })}
                            />
                            {problem && (
                              <span id={`env-row-${row.uid}-problem`} className="env-problem">
                                {problem}
                              </span>
                            )}
                          </td>
                          <td>
                            <ValueInput
                              className="text-input kv-input mono"
                              type={type}
                              aria-label={`Shared value ${n}`}
                              aria-describedby={row.secret ? `env-row-${row.uid}-hint` : undefined}
                              value={row.secret ? '' : row.value}
                              disabled={row.secret}
                              autoComplete="off"
                              spellCheck={false}
                              onValue={(value) => updateRow(row.uid, { value })}
                            />
                            {row.secret && (
                              <span id={`env-row-${row.uid}-hint`} className="env-hint">
                                Secrets are never shared
                              </span>
                            )}
                          </td>
                          <td>
                            <span className="env-current">
                              <ValueInput
                                className="text-input kv-input mono"
                                type={type}
                                aria-label={`Current value ${n}`}
                                aria-describedby={locked ? `env-row-${row.uid}-locked` : undefined}
                                placeholder={locked ? 'Cannot decrypt on this machine' : undefined}
                                value={row.currentValue ?? ''}
                                autoComplete="off"
                                spellCheck={false}
                                onValue={(currentValue) => updateRow(row.uid, { currentValue })}
                              />
                              {row.secret && !locked && (
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  aria-label={shown ? 'Hide value' : 'Show value'}
                                  onClick={() => toggleReveal(row.uid)}
                                >
                                  {shown ? 'Hide' : 'Show'}
                                </button>
                              )}
                            </span>
                            {locked && (
                              <span id={`env-row-${row.uid}-locked`} className="env-hint">
                                Cannot decrypt on this machine. Kept unless you type a new value.
                              </span>
                            )}
                            {row.note && <span className="env-hint">{row.note}</span>}
                          </td>
                          <td className="kv-check">
                            <input
                              type="checkbox"
                              aria-label={`Secret ${n}`}
                              checked={row.secret}
                              onChange={(e) => setSecret(row, e.target.checked)}
                            />
                          </td>
                          <td className="kv-check">
                            <input
                              type="checkbox"
                              aria-label={`Enabled ${n}`}
                              checked={row.enabled}
                              onChange={(e) => updateRow(row.uid, { enabled: e.target.checked })}
                            />
                          </td>
                          <td className="kv-remove">
                            <button
                              type="button"
                              className="btn btn-ghost"
                              aria-label={`Delete variable ${n}`}
                              onClick={() => setDraft((d) => ({ ...d, rows: d.rows.filter((r) => r.uid !== row.uid) }))}
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <button
                  type="button"
                  className="btn kv-add"
                  onClick={() => setDraft((d) => ({ ...d, rows: [...d.rows, blankRow()] }))}
                >
                  Add variable
                </button>
                <p className="muted env-note">
                  Shared values are saved in the workspace and committed to git. Current values and secrets stay on this
                  machine.
                </p>
              </div>
            </div>
          </fieldset>
          {saveError && (
            <p className="env-error" role="alert">
              {saveError}
            </p>
          )}
          {missingOnDisk && (
            <p className="env-error" role="alert">
              This environment was deleted on disk. Your draft is kept; Save writes it again.
            </p>
          )}
          <div className="dialog-actions">
            {changedOnDisk && <span className="env-changed">Changed on disk</span>}
            <button type="button" className="btn" onClick={requestClose} disabled={busy}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={busy || !dirty || invalid}
            >
              Save
            </button>
          </div>
        </div>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title="Delete environment"
          message={`Delete "${draft.name}"? Its file in the workspace and its values on this machine are removed.`}
          confirmLabel="Delete"
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {leaving && (
        <UnsavedChangesDialog
          canSave={!invalid}
          onSave={async () => {
            const run = leaving.run
            setLeaving(null)
            if (await save()) run()
          }}
          onDiscard={() => {
            const run = leaving.run
            setLeaving(null)
            run()
          }}
          onCancel={() => setLeaving(null)}
        />
      )}
    </>
  )
}

type ValueInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string
  onValue(value: string): void
}

/**
 * A text input whose value is set as a DOM property only. A controlled input makes React mirror its value into the
 * `value` attribute, which would put secrets into the markup.
 */
function ValueInput({ value, onValue, ...rest }: ValueInputProps): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (ref.current && ref.current.value !== value) ref.current.value = value
  })
  return <input ref={ref} {...rest} onChange={(e) => onValue(e.target.value)} />
}

interface UnsavedProps {
  /** False while the draft has validation problems. */
  canSave: boolean
  onSave(): void
  onDiscard(): void
  onCancel(): void
}

/** Save / Discard / Cancel before leaving a draft with unsaved changes; focus starts on Cancel and Tab stays inside. */
function UnsavedChangesDialog({ canSave, onSave, onDiscard, onCancel }: UnsavedProps): React.JSX.Element {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => previous?.focus()
  }, [])

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'Tab') {
      const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])]
      const edge = e.shiftKey ? buttons[0] : buttons[buttons.length - 1]
      if (document.activeElement === edge) {
        e.preventDefault()
        buttons[e.shiftKey ? buttons.length - 1 : 0]?.focus()
      }
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        ref={ref}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="dialog-title">
          Unsaved changes
        </h2>
        <p>This environment has changes that are not saved.</p>
        <div className="dialog-actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={onDiscard}>
            Discard
          </button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={!canSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
