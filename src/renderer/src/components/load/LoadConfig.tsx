import { Play } from 'lucide-react'
import { useId } from 'react'
import type { LoadOptions } from '../../../../shared/types'
import { formatCount } from '../../lib/loadReport'
import { LOAD_LIMITS, useApp, type LoadConfig as Config, type LoadState } from '../../state/store'
import { MethodBadge } from '../MethodBadge'
import { boundedInt, NumberField } from '../runner/RunnerConfig'
import type { TargetRow } from './LoadTab'

/** The configuration of a Load test tab: the target requests on the left, the settings on the right. */
export function LoadConfig({
  path,
  state,
  rows,
  onStart,
}: {
  path: string
  state: LoadState
  rows: TargetRow[]
  onStart(options: LoadOptions): void
}): React.JSX.Element {
  const environmentName = useApp((s) =>
    s.activeEnvironmentId === null ? null : (s.environments.find((e) => e.id === s.activeEnvironmentId)?.name ?? null),
  )
  const activeEnvironmentId = useApp((s) => s.activeEnvironmentId)
  const idBase = useId()
  const { config } = state
  const edit = (patch: Partial<Config>): void => useApp.getState().editLoadConfig(path, (c) => ({ ...c, ...patch }))

  const vus = boundedInt(config.vus, LOAD_LIMITS.vus)
  const durationSec = boundedInt(config.durationSec, LOAD_LIMITS.durationSec)
  const rampMax = durationSec ?? LOAD_LIMITS.rampUpSec.max
  const rampUpSec = boundedInt(config.rampUpSec, { min: LOAD_LIMITS.rampUpSec.min, max: rampMax })
  const thinkTimeMs = boundedInt(config.thinkTimeMs, LOAD_LIMITS.thinkTimeMs)
  const timeoutSec = boundedInt(config.timeoutSec, LOAD_LIMITS.timeoutSec)
  const canStart =
    rows.length > 0 &&
    vus !== null &&
    durationSec !== null &&
    rampUpSec !== null &&
    thinkTimeMs !== null &&
    timeoutSec !== null &&
    !state.starting

  function start(): void {
    if (!canStart || vus === null || durationSec === null || rampUpSec === null) return
    if (thinkTimeMs === null || timeoutSec === null) return
    onStart({ path, environmentId: activeEnvironmentId, vus, durationSec, rampUpSec, thinkTimeMs, timeoutSec })
  }

  const range = (bounds: { min: number; max: number }): string =>
    `${formatCount(bounds.min)} to ${formatCount(bounds.max)}`

  return (
    <div className="runner-config">
      <section className="runner-order" aria-labelledby={`${idBase}-targets`}>
        <div className="runner-order-head">
          <h2 id={`${idBase}-targets`} className="runner-heading">
            Requests
          </h2>
          <span className="runner-count">{rows.length === 1 ? '1 request' : `${rows.length} requests`}</span>
        </div>
        {rows.length === 0 ? (
          <p className="muted panel-empty">No requests to load-test</p>
        ) : (
          <ul className="runner-order-list" aria-label="Target requests">
            {rows.map((r) => (
              <li key={r.path} className="load-target" aria-label={`${r.method} ${r.name}`}>
                <MethodBadge method={r.method} />
                <span className="runner-order-name">{r.name}</span>
                <span className="load-target-url" title={r.url}>
                  {r.url}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="runner-settings" aria-label="Load test settings">
        <p className="runner-env">{`Environment: ${environmentName ?? 'No environment'}`}</p>
        <NumberField
          id={`${idBase}-vus`}
          label="Virtual users"
          value={config.vus}
          valid={vus !== null}
          hint={range(LOAD_LIMITS.vus)}
          onChange={(v) => edit({ vus: v })}
        />
        <NumberField
          id={`${idBase}-duration`}
          label="Duration (s)"
          value={config.durationSec}
          valid={durationSec !== null}
          hint={range(LOAD_LIMITS.durationSec)}
          onChange={(v) => edit({ durationSec: v })}
        />
        <NumberField
          id={`${idBase}-ramp`}
          label="Ramp-up (s)"
          value={config.rampUpSec}
          valid={rampUpSec !== null}
          hint={durationSec === null ? '0 to the duration' : `0 to ${formatCount(durationSec)} (the duration)`}
          onChange={(v) => edit({ rampUpSec: v })}
        />
        <NumberField
          id={`${idBase}-think`}
          label="Think time (ms)"
          value={config.thinkTimeMs}
          valid={thinkTimeMs !== null}
          hint={`${range(LOAD_LIMITS.thinkTimeMs)}, after each request`}
          onChange={(v) => edit({ thinkTimeMs: v })}
        />
        <NumberField
          id={`${idBase}-timeout`}
          label="Timeout (s)"
          value={config.timeoutSec}
          valid={timeoutSec !== null}
          hint={range(LOAD_LIMITS.timeoutSec)}
          onChange={(v) => edit({ timeoutSec: v })}
        />

        <div className="load-notes">
          <p className="muted">Scripts are not run during a load test; variables are resolved once at start.</p>
          <p className="muted">Redirects are not followed during a load test.</p>
        </div>

        {state.error !== null && (
          <p role="alert" className="runner-error">
            {`Could not start the load test: ${state.error}`}
          </p>
        )}
        <div>
          <button type="button" className="btn btn-primary" disabled={!canStart} onClick={start}>
            <Play size={14} aria-hidden="true" />
            Start load test
          </button>
        </div>
      </section>
    </div>
  )
}
