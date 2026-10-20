import { Copy, Eye, EyeOff, Layers, Save, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Environment } from '../../../shared/types'
import {
  GLOBALS_ID,
  GLOBALS_NAME,
  blankRow,
  duplicateOf,
  fingerprint,
  isDraftDirty,
  nameProblem,
  newId,
  otherNames,
  rowProblems,
  toDraft,
  toEnvironment,
  uniqueName,
  type Draft,
  type Row,
} from '../lib/environments'
import { hasMod } from '../lib/platform'
import { environmentTabId, useApp } from '../state/store'
import { LoadErrorsBanner } from './Banners'
import { ConfirmDialog } from './ConfirmDialog'

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The stored environment, or the empty globals set that exists before its first save. */
function lookup(id: string): Environment | undefined {
  const found = useApp.getState().environments.find((e) => e.id === id)
  if (found || id !== GLOBALS_ID) return found
  return { id: GLOBALS_ID, name: GLOBALS_NAME, variables: [] }
}

interface Props {
  /** The environment this tab edits; its draft lives in the store (`environmentDrafts`). */
  envId: string
}

/** The editor tab of one environment: its name and a grid of variables, saved with Save or Cmd/Ctrl+S. */
export function EnvironmentEditor({ envId }: Props): React.JSX.Element | null {
  const entry = useApp((s) => s.environmentDrafts[envId])
  const environments = useApp((s) => s.environments)
  const loadErrors = useApp((s) => s.environmentErrors)
  const mounted = useRef(false)
  /** Changes whenever the draft is replaced from disk, so a late save result cannot touch the new draft. */
  const selection = useRef(0)
  /** The uid the trailing empty row gets once something is typed into it, so focus stays in that row. */
  const [nextRow, setNextRow] = useState(() => blankRow())
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const draft = entry?.draft
  const baseline = entry?.baseline ?? ''
  const dirty = entry ? isDraftDirty(entry) : false
  const isGlobals = envId === GLOBALS_ID
  const stored = environments.find((e) => e.id === envId)
  const storedPrint = stored ? fingerprint(stored) : null
  const rowErrors = draft ? rowProblems(draft.rows) : new Map<number, string>()
  const nameError = !draft || isGlobals ? null : nameProblem(draft.name, otherNames(draft, environments))
  const invalid = rowErrors.size > 0 || nameError !== null
  const changedOnDisk = dirty && !draft?.isNew && storedPrint !== null && storedPrint !== baseline
  const missingOnDisk = !!draft && !draft.isNew && !isGlobals && stored === undefined && !busy

  function setDraft(update: (d: Draft) => Draft): void {
    useApp.getState().editEnvironmentDraft(envId, (e) => ({ ...e, draft: update(e.draft) }))
  }

  function show(env: Environment): void {
    selection.current++
    useApp.getState().editEnvironmentDraft(envId, () => ({ draft: toDraft(env), baseline: fingerprint(env) }))
    setRevealed(new Set())
    setSaveError(null)
  }

  // A clean form follows the disk; a dirty one is kept (and flagged) so nothing is overwritten silently. A clean
  // editor of an environment deleted on disk closes.
  useEffect(() => {
    if (busy || !draft || draft.isNew || dirty) return
    if (stored && storedPrint !== baseline) show(stored)
    else if (missingOnDisk) useApp.getState().closeTab(environmentTabId(envId), { discard: true })
  })

  if (!draft) return null

  async function save(): Promise<boolean> {
    const current = useApp.getState().environmentDrafts[envId]
    if (busy || !current || !isDraftDirty(current) || invalid) return false
    const env = toEnvironment(current.draft)
    const mine = selection.current
    setBusy(true)
    setSaveError(null)
    try {
      const applied = await useApp.getState().saveEnvironment(env)
      // Applied even if the tab was switched meanwhile: the draft is in the store, not in this component.
      if (!applied || mine !== selection.current) return applied
      useApp.getState().editEnvironmentDraft(envId, (e) => ({
        draft: { ...e.draft, name: env.name, isNew: false },
        baseline: fingerprint(env),
      }))
      return true
    } catch (e) {
      if (mounted.current && mine === selection.current) setSaveError(messageOf(e))
      return false
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  function duplicate(): void {
    const source = draft?.isNew ? toEnvironment(draft) : lookup(envId)
    if (!source) return
    const names = [...useApp.getState().environments.map((e) => e.name), GLOBALS_NAME]
    const id = newId()
    useApp
      .getState()
      .openEnvironment(id, toDraft(duplicateOf(source, uniqueName(`${source.name} copy`, names), id), true))
  }

  async function remove(): Promise<void> {
    setConfirmDelete(false)
    setBusy(true)
    setSaveError(null)
    try {
      // On success the store closes this tab.
      await useApp.getState().removeEnvironment(envId)
    } catch (e) {
      if (mounted.current) setSaveError(messageOf(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  function updateRow(uid: number, patch: Partial<Row>): void {
    setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)) }))
  }

  /** Typing into the trailing empty row turns it into a real row. */
  function addRow(patch: Partial<Row>): void {
    const row = { ...nextRow, ...patch }
    setDraft((d) => ({ ...d, rows: [...d.rows, row] }))
    setNextRow(blankRow())
  }

  function setSecret(row: Row, secret: boolean): void {
    if (secret === row.secret) return
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
        note: 'Initial value moved to the current value.',
      })
    } else {
      updateRow(row.uid, {
        secret: true,
        value: '',
        note: 'Initial value removed; the existing current value was kept.',
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
    if (hasMod(e) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
    }
  }

  const trailing = draft.rows.length + 1

  return (
    <div className="env-editor" onKeyDown={onKeyDown}>
      <div className="env-editor-head">
        <Layers size={16} aria-hidden="true" />
        {isGlobals ? (
          <h2 className="env-name-heading">{GLOBALS_NAME}</h2>
        ) : (
          <div className="env-name-field">
            <input
              className="env-name-input"
              aria-label="Environment name"
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? 'env-name-problem' : undefined}
              value={draft.name}
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
            {nameError && (
              <span id="env-name-problem" className="env-problem">
                {nameError}
              </span>
            )}
          </div>
        )}
        <div className="env-editor-actions">
          {draft.isNew && <span className="env-state">Not saved yet</span>}
          {changedOnDisk && <span className="env-state">Changed on disk</span>}
          <button
            type="button"
            className="btn btn-ghost"
            title="Copies the variables. Secret values are not copied, only their keys with empty values."
            disabled={busy}
            onClick={duplicate}
          >
            <Copy size={14} aria-hidden="true" />
            Duplicate
          </button>
          {!isGlobals && !draft.isNew && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} aria-hidden="true" />
              Delete environment
            </button>
          )}
          <button type="button" className="btn" onClick={() => void save()} disabled={busy || !dirty || invalid}>
            <Save size={14} aria-hidden="true" />
            Save
          </button>
        </div>
      </div>
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
      <LoadErrorsBanner errors={loadErrors} />
      <div className="env-editor-body">
        <p className="env-help">
          Initial values are saved in the workspace folder and synced with git. Current values and secrets stay on this
          machine.
        </p>
        <fieldset className="env-fieldset" disabled={busy}>
          <legend className="sr-only">Variables</legend>
          <table className="grid-table env-table">
            <thead>
              <tr>
                <th scope="col" className="grid-check">
                  <span className="sr-only">Enabled</span>
                </th>
                <th scope="col">Variable</th>
                <th scope="col" className="grid-type">
                  Type
                </th>
                <th scope="col">Initial value</th>
                <th scope="col">Current value</th>
                <th scope="col" className="grid-actions">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                ...draft.rows.map((row, i) => {
                  const n = i + 1
                  const problem = rowErrors.get(row.uid)
                  // Until a new value is typed: the stored one cannot be decrypted here, so there is nothing to reveal.
                  const locked = row.secret && row.locked === true && !row.currentValue
                  const shown = revealed.has(row.uid) && !locked
                  const type = row.secret && !shown ? 'password' : 'text'
                  return (
                    <tr key={row.uid} className={row.enabled ? undefined : 'grid-disabled'}>
                      <td className="grid-check">
                        <input
                          type="checkbox"
                          aria-label={`Enabled ${n}`}
                          checked={row.enabled}
                          onChange={(e) => updateRow(row.uid, { enabled: e.target.checked })}
                        />
                      </td>
                      <td>
                        <input
                          className="grid-input mono"
                          aria-label={`Variable name ${n}`}
                          aria-invalid={problem ? true : undefined}
                          aria-describedby={problem ? `env-row-${row.uid}-problem` : undefined}
                          placeholder="Variable"
                          value={row.key}
                          spellCheck={false}
                          onChange={(e) => updateRow(row.uid, { key: e.target.value })}
                        />
                        {problem && (
                          <span id={`env-row-${row.uid}-problem`} className="grid-note grid-problem">
                            {problem}
                          </span>
                        )}
                      </td>
                      <td className="grid-type">
                        <select
                          className="grid-input"
                          aria-label={`Type ${n}`}
                          value={row.secret ? 'secret' : 'default'}
                          onChange={(e) => setSecret(row, e.target.value === 'secret')}
                        >
                          <option value="default">default</option>
                          <option value="secret">secret</option>
                        </select>
                      </td>
                      <td>
                        <ValueInput
                          className="grid-input mono"
                          type={type}
                          aria-label={`Initial value ${n}`}
                          placeholder={row.secret ? 'Secrets are never shared' : 'Initial value'}
                          value={row.secret ? '' : row.value}
                          disabled={row.secret}
                          autoComplete="off"
                          spellCheck={false}
                          onValue={(value) => updateRow(row.uid, { value })}
                        />
                      </td>
                      <td>
                        <span className="grid-cell-flex">
                          <ValueInput
                            className="grid-input mono"
                            type={type}
                            aria-label={`Current value ${n}`}
                            aria-describedby={locked ? `env-row-${row.uid}-locked` : undefined}
                            placeholder={locked ? 'Cannot decrypt on this machine' : 'Current value'}
                            value={row.currentValue ?? ''}
                            autoComplete="off"
                            spellCheck={false}
                            onValue={(currentValue) => updateRow(row.uid, { currentValue })}
                          />
                          {row.secret && !locked && (
                            <button
                              type="button"
                              className="icon-btn icon-btn-sm"
                              aria-label={shown ? 'Hide value' : 'Show value'}
                              title={shown ? 'Hide value' : 'Show value'}
                              onClick={() => toggleReveal(row.uid)}
                            >
                              {shown ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                            </button>
                          )}
                        </span>
                        {locked && (
                          <span id={`env-row-${row.uid}-locked`} className="grid-note">
                            Cannot decrypt on this machine. Kept unless you type a new value.
                          </span>
                        )}
                        {row.note && <span className="grid-note">{row.note}</span>}
                      </td>
                      <td className="grid-actions">
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm grid-row-btn"
                          aria-label={`Delete variable ${n}`}
                          title="Delete variable"
                          onClick={() => setDraft((d) => ({ ...d, rows: d.rows.filter((r) => r.uid !== row.uid) }))}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  )
                }),
                // In the same list as the rows: the row it turns into keeps its key, so the focus stays.
                <tr key={nextRow.uid}>
                  <td className="grid-check" />
                  <td>
                    <input
                      className="grid-input mono"
                      aria-label={`Variable name ${trailing}`}
                      placeholder="Add a variable"
                      value=""
                      spellCheck={false}
                      onChange={(e) => addRow({ key: e.target.value })}
                    />
                  </td>
                  <td className="grid-type" />
                  <td>
                    <ValueInput
                      className="grid-input mono"
                      aria-label={`Initial value ${trailing}`}
                      placeholder="Initial value"
                      value=""
                      autoComplete="off"
                      spellCheck={false}
                      onValue={(value) => addRow({ value })}
                    />
                  </td>
                  <td>
                    {/* Same structure as a real row, so the focused input survives turning into one. */}
                    <span className="grid-cell-flex">
                      <ValueInput
                        className="grid-input mono"
                        aria-label={`Current value ${trailing}`}
                        placeholder="Current value"
                        value=""
                        autoComplete="off"
                        spellCheck={false}
                        onValue={(currentValue) => addRow({ currentValue })}
                      />
                    </span>
                  </td>
                  <td className="grid-actions" />
                </tr>,
              ]}
            </tbody>
          </table>
        </fieldset>
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
    </div>
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
