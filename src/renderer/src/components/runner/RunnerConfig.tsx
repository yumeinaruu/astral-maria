import { FileUp, Play, X } from 'lucide-react'
import { useId, useMemo } from 'react'
import type { RunOptions } from '../../../../shared/types'
import {
  requestsInRunOrder,
  RUN_LIMITS,
  useApp,
  type RunnerConfig as Config,
  type RunnerState,
} from '../../state/store'
import { MethodBadge } from '../MethodBadge'

/** Rows of the data file shown in the preview. */
const PREVIEW_ROWS = 5

/** The whole number in `text` when it lies within `bounds`, else null. */
export function boundedInt(text: string, bounds: { min: number; max: number }): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const n = Number(text)
  return n >= bounds.min && n <= bounds.max ? n : null
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

const formatLimit = (n: number): string => n.toLocaleString('en-US').replace(/,/g, ' ')

/** The configuration of a Runner tab: the requests to run on the left, the settings on the right. */
export function RunnerConfig({ path, name, state }: { path: string; name: string; state: RunnerState }) {
  const collections = useApp((s) => s.collections)
  const environmentName = useApp((s) =>
    s.activeEnvironmentId === null ? null : (s.environments.find((e) => e.id === s.activeEnvironmentId)?.name ?? null),
  )
  const activeEnvironmentId = useApp((s) => s.activeEnvironmentId)
  const requests = useMemo(() => requestsInRunOrder(collections, path), [collections, path])
  const idBase = useId()
  const { config } = state
  const edit = (patch: Partial<Config>): void => useApp.getState().editRunnerConfig(path, (c) => ({ ...c, ...patch }))

  const deselected = new Set(config.deselected)
  const selected = requests.filter((r) => !deselected.has(r.path))
  const iterations = boundedInt(config.iterations, RUN_LIMITS.iterations)
  const delayMs = boundedInt(config.delayMs, RUN_LIMITS.delayMs)
  const canRun = selected.length > 0 && iterations !== null && delayMs !== null && !state.starting

  function toggle(requestPath: string, on: boolean): void {
    const rest = config.deselected.filter((p) => p !== requestPath)
    edit({ deselected: on ? rest : [...rest, requestPath] })
  }

  async function pickData(): Promise<void> {
    try {
      const data = await window.astral.runner.pickDataFile()
      if (data) edit({ data, dataError: null })
    } catch (e) {
      edit({ dataError: e instanceof Error ? e.message : String(e) })
    }
  }

  function run(): void {
    if (!canRun || iterations === null || delayMs === null) return
    const options: RunOptions = {
      path,
      requestPaths: selected.map((r) => r.path),
      environmentId: activeEnvironmentId,
      iterations,
      delayMs,
      data: config.data,
      keepVariables: config.keepVariables,
      stopOnError: config.stopOnError,
    }
    void useApp.getState().startRun(path, options)
  }

  const preview = config.data?.rows.slice(0, PREVIEW_ROWS) ?? []
  const columns = [...new Set(preview.flatMap((row) => Object.keys(row)))]
  const rowCount = config.data?.rows.length ?? 0

  return (
    <div className="runner-config">
      <section className="runner-order" aria-labelledby={`${idBase}-order`}>
        <div className="runner-order-head">
          <h2 id={`${idBase}-order`} className="runner-heading">
            Run order
          </h2>
          <span className="runner-count">{`${selected.length} of ${requests.length} selected`}</span>
          <span className="toolbar-spacer" />
          <button type="button" className="btn-text" onClick={() => edit({ deselected: [] })}>
            Select all
          </button>
          <button type="button" className="btn-text" onClick={() => edit({ deselected: requests.map((r) => r.path) })}>
            Deselect all
          </button>
        </div>
        {requests.length === 0 ? (
          <p className="muted panel-empty">No requests to run</p>
        ) : (
          <ul className="runner-order-list" aria-label="Run order">
            {requests.map((r) => (
              <li key={r.path}>
                <label className="runner-order-item">
                  <input
                    type="checkbox"
                    aria-label={r.name}
                    checked={!deselected.has(r.path)}
                    onChange={(e) => toggle(r.path, e.currentTarget.checked)}
                  />
                  <MethodBadge method={r.method} />
                  <span className="runner-order-name">{r.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="runner-settings" aria-label="Run settings">
        <p className="runner-env">{`Environment: ${environmentName ?? 'No environment'}`}</p>
        <NumberField
          id={`${idBase}-iterations`}
          label="Iterations"
          value={config.iterations}
          valid={iterations !== null}
          hint={`1 to ${formatLimit(RUN_LIMITS.iterations.max)}`}
          onChange={(v) => edit({ iterations: v })}
        />
        <NumberField
          id={`${idBase}-delay`}
          label="Delay (ms)"
          value={config.delayMs}
          valid={delayMs !== null}
          hint={`0 to ${formatLimit(RUN_LIMITS.delayMs.max)}`}
          onChange={(v) => edit({ delayMs: v })}
        />

        <div className="runner-field">
          <span className="runner-label">Data</span>
          {config.data ? (
            <div className="runner-data">
              <div className="runner-data-head">
                <span className="runner-data-name">{config.data.name}</span>
                <span className="muted">{rowCount === 1 ? '1 row' : `${rowCount} rows`}</span>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  aria-label="Remove data file"
                  title="Remove data file"
                  onClick={() => edit({ data: null, dataError: null })}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
              {columns.length > 0 && (
                <div className="runner-data-preview">
                  <table className="grid-table runner-data-table" aria-label="Data preview">
                    <thead>
                      <tr>
                        {columns.map((c) => (
                          <th key={c} scope="col">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row, i) => (
                        <tr key={i}>
                          {columns.map((c) => (
                            <td key={c}>{cellText(row[c])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div>
              <button type="button" className="btn" onClick={() => void pickData()}>
                <FileUp size={14} aria-hidden="true" />
                Select file
              </button>
            </div>
          )}
          {config.dataError !== null && (
            <p role="alert" className="runner-error">
              {config.dataError}
            </p>
          )}
        </div>

        <label className="runner-check">
          <input
            type="checkbox"
            checked={config.keepVariables}
            onChange={(e) => edit({ keepVariables: e.currentTarget.checked })}
          />
          Keep variable values
        </label>
        <label className="runner-check">
          <input
            type="checkbox"
            checked={config.stopOnError}
            onChange={(e) => edit({ stopOnError: e.currentTarget.checked })}
          />
          Stop run if a test fails or a request errors
        </label>

        {state.error !== null && (
          <p role="alert" className="runner-error">
            {`Could not start the run: ${state.error}`}
          </p>
        )}
        <div>
          <button type="button" className="btn btn-primary runner-run" disabled={!canRun} onClick={run}>
            <Play size={14} aria-hidden="true" />
            {`Run ${name}`}
          </button>
        </div>
      </section>
    </div>
  )
}

function NumberField(props: {
  id: string
  label: string
  value: string
  valid: boolean
  hint: string
  onChange(value: string): void
}): React.JSX.Element {
  return (
    <div className="runner-field">
      <label className="runner-label" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        className="text-input runner-number"
        type="number"
        inputMode="numeric"
        value={props.value}
        aria-invalid={!props.valid}
        aria-describedby={`${props.id}-hint`}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      />
      <span id={`${props.id}-hint`} className={props.valid ? 'runner-hint' : 'runner-hint runner-error'}>
        {props.hint}
      </span>
    </div>
  )
}
