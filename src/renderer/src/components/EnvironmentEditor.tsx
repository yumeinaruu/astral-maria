import {
  ChevronDown,
  Cloud,
  Copy,
  Eye,
  EyeOff,
  Laptop,
  Layers,
  Lock,
  MoreHorizontal,
  Save,
  Search,
  Trash2,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Environment } from '../../../shared/types'
import {
  GLOBALS_ID,
  GLOBALS_NAME,
  afterSave,
  blankRow,
  duplicateOf,
  duplicateRow,
  fingerprint,
  isDraftDirty,
  isLocal,
  nameProblem,
  otherNames,
  rowProblems,
  shownValue,
  switchSync,
  toDraft,
  toEnvironment,
  writeValue,
  type Draft,
  type Row,
} from '../lib/environments'
import { hasMod, shortcut } from '../lib/platform'
import { createEnvironment } from '../lib/tabs'
import { environmentTabId, useApp } from '../state/store'
import { LoadErrorsBanner } from './Banners'
import { ConfirmDialog } from './ConfirmDialog'
import type { MenuEntry } from './ContextMenu'
import { MenuButton } from './MenuButton'

const HELP =
  'Initial values are saved in the workspace folder and synced with git. Current values and secrets stay on this machine.'
const SHARED_LABEL = 'Shared: saved in the workspace and synced with git'
const LOCAL_LABEL = 'Local: only on this machine'

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The stored environment, or the empty globals set that exists before its first save. */
function lookup(id: string): Environment | undefined {
  const found = useApp.getState().environments.find((e) => e.id === id)
  if (found || id !== GLOBALS_ID) return found
  return { id: GLOBALS_ID, name: GLOBALS_NAME, variables: [] }
}

/** Until a new value is typed: the stored one cannot be decrypted here, so there is nothing to show. */
function isLocked(row: Row): boolean {
  return row.secret && row.locked === true && !row.currentValue
}

interface Props {
  /** The environment this tab edits; its draft lives in the store (`environmentDrafts`). */
  envId: string
}

/**
 * The editor tab of one environment: its name and a `Variable | Value` grid, saved with Save or Cmd/Ctrl+S. The Value
 * cell shows the effective value (the local one if set, otherwise the shared one) and writes to the side it shows.
 */
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
  const [query, setQuery] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** The latest Save action, for the shortcut. */
  const saveRef = useRef<() => void>(() => undefined)
  // Cmd/Ctrl+S saves the draft wherever the focus is. Captured on the window, so an input that stops the key's
  // propagation (inline rename, CodeMirror) cannot swallow it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (hasMod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
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
  const changedOnDisk = dirty && storedPrint !== null && storedPrint !== baseline
  const missingOnDisk = !!draft && !isGlobals && stored === undefined && !busy

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
    if (busy || !draft || dirty) return
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
        draft: afterSave({ ...e.draft, name: env.name }),
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

  /** Writes a copy of the stored environment at once and opens it, its sidebar row in rename. */
  function duplicate(): void {
    const source = lookup(envId)
    if (!source) return
    void createEnvironment(`${source.name} copy`, duplicateOf(source, source.name, source.id).variables)
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

  /** Typing into the trailing empty row turns it into a real, shared row. */
  function addRow(patch: Partial<Row>): void {
    const row: Row = { ...nextRow, ...patch, fresh: true }
    setDraft((d) => ({ ...d, rows: [...d.rows, row] }))
    setNextRow(blankRow())
  }

  function duplicateVariable(row: Row): void {
    setDraft((d) => {
      const copy = duplicateRow(
        row,
        d.rows.map((r) => r.key),
      )
      const at = d.rows.findIndex((r) => r.uid === row.uid)
      return { ...d, rows: [...d.rows.slice(0, at + 1), copy, ...d.rows.slice(at + 1)] }
    })
  }

  function setSecret(row: Row, secret: boolean): void {
    if (secret === row.secret) return
    if (!secret && row.locked) {
      updateRow(row.uid, {
        secret: false,
        locked: undefined,
        lockedKey: undefined,
        local: false,
        note: 'The value that could not be decrypted is removed when you save.',
      })
    } else if (!secret) {
      updateRow(row.uid, { secret: false, local: !!row.currentValue, note: undefined })
    } else if (row.value === '') {
      updateRow(row.uid, { secret: true, note: undefined })
    } else if (!row.currentValue) {
      updateRow(row.uid, {
        secret: true,
        value: '',
        currentValue: row.value,
        note: 'The shared value now stays on this machine only.',
      })
    } else {
      updateRow(row.uid, {
        secret: true,
        value: '',
        note: 'Shared value removed; the local value was kept.',
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

  saveRef.current = () => void save()

  const revealable = draft.rows.filter((r) => r.secret && !isLocked(r))
  const allShown = revealable.length > 0 && revealable.every((r) => revealed.has(r.uid))
  const needle = query?.trim().toLowerCase() ?? ''
  const visible = draft.rows
    .map((row, i) => ({ row, n: i + 1 }))
    .filter(({ row }) => needle === '' || row.key.toLowerCase().includes(needle))
  const trailing = draft.rows.length + 1

  const optionsMenu = (): MenuEntry[] => [
    {
      label: allShown ? 'Hide secrets' : 'Show secrets',
      onSelect: () => setRevealed(allShown ? new Set() : new Set(revealable.map((r) => r.uid))),
    },
    { separator: true },
    { note: HELP, wrap: true },
  ]

  return (
    <div className="env-editor">
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
          {changedOnDisk && <span className="env-state">Changed on disk</span>}
          <button
            type="button"
            className="btn-text"
            title="Copies the variables. Secret values are not copied, only their keys with empty values."
            disabled={busy}
            onClick={duplicate}
          >
            <Copy size={14} aria-hidden="true" />
            Duplicate
          </button>
          {!isGlobals && (
            <button
              type="button"
              className="btn-text"
              aria-label="Delete environment"
              title="Delete environment"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete
            </button>
          )}
          <button
            type="button"
            className="btn-text save-btn"
            title={`Save (${shortcut('S')})`}
            onClick={() => void save()}
            disabled={busy || !dirty || invalid}
          >
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
        <fieldset className="env-fieldset" disabled={busy}>
          <legend className="sr-only">Variables</legend>
          <table className="grid-table env-table">
            <colgroup>
              <col className="env-col-name" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Variable</th>
                <th scope="col">
                  <div className="env-value-head">
                    <span className="env-value-label">Value</span>
                    {query !== null && (
                      <input
                        className="env-search"
                        type="search"
                        aria-label="Filter variables"
                        placeholder="Filter variables"
                        value={query}
                        spellCheck={false}
                        autoFocus
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.stopPropagation()
                            setQuery(null)
                          }
                        }}
                      />
                    )}
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm toggle-btn"
                      aria-label="Search variables"
                      title="Search variables"
                      aria-pressed={query !== null}
                      onClick={() => setQuery(query === null ? '' : null)}
                    >
                      <Search size={14} aria-hidden="true" />
                    </button>
                    <MenuButton
                      label="Variable options"
                      className="icon-btn icon-btn-sm"
                      align="end"
                      items={optionsMenu}
                    >
                      <MoreHorizontal size={14} aria-hidden="true" />
                    </MenuButton>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                // Called, not rendered as a component: a `<tr>` like the trailing row, so that row keeps its
                // inputs (and the focus) when it turns into a variable.
                ...visible.map(({ row, n }) =>
                  variableRow({
                    row,
                    n,
                    problem: rowErrors.get(row.uid),
                    revealed: revealed.has(row.uid),
                    onChange: (patch) => updateRow(row.uid, patch),
                    onSecret: (secret) => setSecret(row, secret),
                    onReveal: () => toggleReveal(row.uid),
                    onDuplicate: () => duplicateVariable(row),
                    onDelete: () => setDraft((d) => ({ ...d, rows: d.rows.filter((r) => r.uid !== row.uid) })),
                  }),
                ),
                // In the same list as the rows: the row it turns into keeps its key, so the focus stays. Hidden while
                // filtering, as a new variable would vanish from the filtered list while it is typed.
                ...(needle !== ''
                  ? []
                  : [
                      <tr key={nextRow.uid} className="env-trailing">
                        <td>
                          <div className="env-cell">
                            <input
                              className="grid-input"
                              aria-label={`Variable name ${trailing}`}
                              placeholder="Add variable"
                              value=""
                              spellCheck={false}
                              onChange={(e) => addRow({ key: e.target.value })}
                            />
                          </div>
                        </td>
                        <td>
                          {/* Same structure as a real row, so the focused input survives turning into one. */}
                          <div className="env-cell">
                            <ValueInput
                              className="grid-input"
                              aria-label={`Value ${trailing}`}
                              value=""
                              autoComplete="off"
                              spellCheck={false}
                              onValue={(value) => addRow({ value })}
                            />
                          </div>
                        </td>
                      </tr>,
                    ]),
              ]}
            </tbody>
          </table>
          {needle !== '' && visible.length === 0 && <p className="env-empty">No variables match “{query?.trim()}”</p>}
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

interface RowProps {
  row: Row
  /** Position in the whole list (not the filtered one), used in the accessible names. */
  n: number
  problem: string | undefined
  revealed: boolean
  onChange(patch: Partial<Row>): void
  onSecret(secret: boolean): void
  onReveal(): void
  onDuplicate(): void
  onDelete(): void
}

/** One variable's `<tr>` (keyed by the row uid). */
function variableRow({
  row,
  n,
  problem,
  revealed,
  onChange,
  onSecret,
  onReveal,
  onDuplicate,
  onDelete,
}: RowProps): React.JSX.Element {
  const locked = isLocked(row)
  const shown = revealed && !locked
  const local = isLocal(row)

  const typeMenu: MenuEntry[] = [
    { label: 'Default', checked: !row.secret, onSelect: () => onSecret(false) },
    { label: 'Secret', checked: row.secret, onSelect: () => onSecret(true) },
  ]
  const syncMenu = (): MenuEntry[] => [
    { label: SHARED_LABEL, checked: !local, onSelect: () => !local || onChange(switchSync(row, 'shared')) },
    { label: LOCAL_LABEL, checked: local, onSelect: () => local || onChange(switchSync(row, 'local')) },
    ...(local && row.value !== ''
      ? ([{ separator: true }, { note: `Shared value: ${row.value}`, title: row.value }] as MenuEntry[])
      : []),
  ]
  const rowMenu: MenuEntry[] = [
    { label: row.enabled ? 'Disable' : 'Enable', onSelect: () => onChange({ enabled: !row.enabled }) },
    { label: 'Duplicate row', onSelect: onDuplicate },
    { separator: true },
    { label: 'Delete', danger: true, onSelect: onDelete },
  ]

  return (
    <tr key={row.uid} className={`env-var${row.enabled ? '' : ' grid-disabled'}`}>
      <td>
        <div className="env-cell">
          <input
            className="grid-input"
            aria-label={`Variable name ${n}`}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `env-row-${row.uid}-problem` : undefined}
            placeholder="Variable"
            value={row.key}
            spellCheck={false}
            onChange={(e) => onChange({ key: e.target.value })}
          />
          <MenuButton
            label={`Type ${n}`}
            title={row.secret ? 'Type: secret' : 'Type: default'}
            className={`icon-btn env-cell-btn env-type-btn${row.secret ? ' env-type-secret' : ''}`}
            align="end"
            items={typeMenu}
          >
            <Lock size={12} aria-hidden="true" />
            <ChevronDown size={10} aria-hidden="true" />
          </MenuButton>
        </div>
        {problem && (
          <span id={`env-row-${row.uid}-problem`} className="grid-note grid-problem">
            {problem}
          </span>
        )}
      </td>
      <td>
        <div className="env-cell">
          <ValueInput
            className="grid-input"
            type={row.secret && !shown ? 'password' : 'text'}
            aria-label={`Value ${n}`}
            aria-describedby={locked ? `env-row-${row.uid}-locked` : undefined}
            placeholder={locked ? 'Cannot decrypt on this machine' : undefined}
            value={shownValue(row)}
            autoComplete="off"
            spellCheck={false}
            onValue={(text) => onChange(writeValue(row, text))}
          />
          {row.secret && !locked && (
            <button
              type="button"
              className="icon-btn icon-btn-sm env-hover-btn"
              aria-label={shown ? `Hide value ${n}` : `Show value ${n}`}
              title={shown ? 'Hide value' : 'Show value'}
              onClick={onReveal}
            >
              {shown ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
            </button>
          )}
          {!row.secret && (
            <MenuButton
              label={`Storage of value ${n}`}
              title={local ? 'Local: only on this machine' : 'Shared: synced with git'}
              className="icon-btn env-cell-btn env-sync-btn"
              menuLabel="Where the value is kept"
              align="end"
              items={syncMenu}
            >
              {local ? <Laptop size={13} aria-hidden="true" /> : <Cloud size={13} aria-hidden="true" />}
              <ChevronDown size={10} aria-hidden="true" />
            </MenuButton>
          )}
          <MenuButton
            label={`Actions for variable ${n}`}
            className="icon-btn icon-btn-sm env-hover-btn"
            align="end"
            items={rowMenu}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </MenuButton>
        </div>
        {locked && (
          <span id={`env-row-${row.uid}-locked`} className="grid-note">
            Cannot decrypt on this machine. Kept unless you type a new value.
          </span>
        )}
        {row.note && <span className="grid-note">{row.note}</span>}
      </td>
    </tr>
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
