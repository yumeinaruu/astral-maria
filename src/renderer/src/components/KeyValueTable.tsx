import { Check, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { KeyValue } from '../../../shared/types'
import { fromBulkText, toBulkText } from '../lib/bulkEdit'
import { VarInput } from './VarInput'

interface Props {
  rows: KeyValue[]
  onChange(rows: KeyValue[]): void
  /** Singular lower-case name of a row ("param", "header", "field"); used in the accessible names. */
  noun: string
  /** The title line above the grid, e.g. "Query Params". */
  title?: string
}

const BLANK: KeyValue = { key: '', value: '', enabled: true }

/**
 * A grid of key/value/description rows with an enabled check. One empty row always trails the others; typing in it
 * creates a row. Bulk Edit swaps the grid for `key:value` lines.
 */
export function KeyValueTable({ rows, onChange, noun, title }: Props): React.JSX.Element {
  /** The Bulk Edit text, and the rows it last stood for; rows changed elsewhere (the URL) replace the text. */
  const [bulkState, setBulkState] = useState<{ text: string; rowsText: string } | null>(null)
  const rowsText = toBulkText(rows)
  if (bulkState !== null && bulkState.rowsText !== rowsText) setBulkState({ text: rowsText, rowsText })
  const bulk = bulkState?.text ?? null
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)

  function update(index: number, patch: Partial<KeyValue>): void {
    if (index === rows.length) onChange([...rows, { ...BLANK, ...patch }])
    else onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const toggle = (
    <button
      type="button"
      className="btn-text kv-bulk-toggle"
      aria-pressed={bulk !== null}
      onClick={() => setBulkState(bulk === null ? { text: rowsText, rowsText } : null)}
    >
      {bulk === null ? 'Bulk Edit' : 'Key-Value Edit'}
    </button>
  )

  return (
    <div className="kv">
      {(title || bulk !== null) && (
        <div className="kv-title-line">
          {title && <span className="kv-title">{title}</span>}
          {bulk !== null && toggle}
        </div>
      )}
      {bulk !== null ? (
        <textarea
          className="kv-bulk mono"
          aria-label={`${Noun}s as key:value lines`}
          value={bulk}
          spellCheck={false}
          placeholder={'key:value\n// disabled:value'}
          onChange={(e) => {
            const next = fromBulkText(e.target.value, rows)
            setBulkState({ text: e.target.value, rowsText: toBulkText(next) })
            onChange(next)
          }}
        />
      ) : (
        <table className="grid-table kv-table">
          <colgroup>
            <col className="kv-col-check" />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="grid-check">
                <span className="sr-only">Enabled</span>
              </th>
              <th scope="col">Key</th>
              <th scope="col">Value</th>
              <th scope="col">
                <div className="kv-desc-head">
                  <span className="kv-desc-label">Description</span>
                  {toggle}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {[...rows, BLANK].map((row, i) => {
              const trailing = i === rows.length
              return (
                <tr key={i} className={`${row.enabled ? '' : 'grid-disabled'}${trailing ? ' kv-trailing' : ''}`}>
                  <td className="grid-check">
                    {!trailing && (
                      <label className="kv-check">
                        <input
                          type="checkbox"
                          aria-label={`${Noun} ${i + 1} enabled`}
                          checked={row.enabled}
                          onChange={(e) => update(i, { enabled: e.target.checked })}
                        />
                        <Check size={14} strokeWidth={2.25} aria-hidden="true" />
                      </label>
                    )}
                  </td>
                  <td>
                    <VarInput
                      className="grid-input"
                      aria-label={`${Noun} key ${i + 1}`}
                      placeholder={trailing ? 'Key' : undefined}
                      value={row.key}
                      onChange={(key) => update(i, { key })}
                    />
                  </td>
                  <td>
                    <VarInput
                      className="grid-input"
                      aria-label={`${Noun} value ${i + 1}`}
                      placeholder={trailing ? 'Value' : undefined}
                      value={row.value}
                      onChange={(value) => update(i, { value })}
                    />
                  </td>
                  <td>
                    <div className="grid-cell-flex">
                      <VarInput
                        className="grid-input"
                        aria-label={`${Noun} description ${i + 1}`}
                        placeholder={trailing ? 'Description' : undefined}
                        value={row.description ?? ''}
                        onChange={(description) => {
                          if (description === '' && !trailing) {
                            const { description: _dropped, ...rest } = row
                            onChange(rows.map((r, j) => (j === i ? rest : r)))
                          } else update(i, { description })
                        }}
                      />
                      {!trailing && (
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm grid-row-btn"
                          aria-label={`Remove ${noun} ${i + 1}`}
                          title="Remove"
                          onClick={() => onChange(rows.filter((_, j) => j !== i))}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
