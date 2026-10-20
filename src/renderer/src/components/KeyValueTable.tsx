import type { KeyValue } from '../../../shared/types'

interface Props {
  rows: KeyValue[]
  onChange(rows: KeyValue[]): void
  /** Singular lower-case name of a row ("param", "header", "field"); used in the accessible names. */
  noun: string
}

/** Editable key/value rows with an enabled checkbox. The description of a row is kept but not shown. */
export function KeyValueTable({ rows, onChange, noun }: Props): React.JSX.Element {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)

  function update(index: number, patch: Partial<KeyValue>): void {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  return (
    <div className="kv">
      {rows.length > 0 && (
        <table className="kv-table">
          <thead>
            <tr>
              <th scope="col" className="kv-check">
                <span className="sr-only">Enabled</span>
              </th>
              <th scope="col">Key</th>
              <th scope="col">Value</th>
              <th scope="col" className="kv-remove">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={row.enabled ? undefined : 'kv-disabled'}>
                <td className="kv-check">
                  <input
                    type="checkbox"
                    aria-label={`${Noun} ${i + 1} enabled`}
                    checked={row.enabled}
                    onChange={(e) => update(i, { enabled: e.target.checked })}
                  />
                </td>
                <td>
                  <input
                    className="text-input kv-input mono"
                    type="text"
                    aria-label={`${Noun} key ${i + 1}`}
                    value={row.key}
                    spellCheck={false}
                    onChange={(e) => update(i, { key: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="text-input kv-input mono"
                    type="text"
                    aria-label={`${Noun} value ${i + 1}`}
                    value={row.value}
                    spellCheck={false}
                    onChange={(e) => update(i, { value: e.target.value })}
                  />
                </td>
                <td className="kv-remove">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    aria-label={`Remove ${noun} ${i + 1}`}
                    onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button
        type="button"
        className="btn kv-add"
        onClick={() => onChange([...rows, { key: '', value: '', enabled: true }])}
      >
        Add {noun}
      </button>
    </div>
  )
}
