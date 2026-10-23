import { CircleAlert, Download, RotateCcw, Settings2, Square } from 'lucide-react'
import { useState } from 'react'
import type { LoadOptions, LoadStopReason } from '../../../../shared/types'
import {
  buildLoadReport,
  formatCount,
  formatMs,
  formatPercent,
  formatRps,
  loadReportFileName,
} from '../../lib/loadReport'
import { useApp, type LoadState } from '../../state/store'
import { LineChart, type ChartSeries } from './LineChart'

/** How the end of a load test reads in the results. */
export function loadReasonText(reason: LoadStopReason, message?: string): string {
  if (reason === 'completed') return 'Completed'
  if (reason === 'stopped') return 'Stopped'
  return message ? `Failed: ${message}` : 'Failed'
}

/** The live and final results of a Load test tab's test. */
export function LoadResults({
  path,
  name,
  state,
  onRunAgain,
}: {
  path: string
  name: string
  state: LoadState
  onRunAgain(options: LoadOptions): void
}): React.JSX.Element {
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(null)
  const test = state.test
  if (!test) return <p className="muted panel-empty">No load test yet</p>

  const store = useApp.getState
  const running = test.finished === null
  const totals = test.totals
  const ticks = test.ticks
  const duration = test.options.durationSec
  const elapsed = Math.min(duration, ticks.length > 0 ? ticks[ticks.length - 1]!.t + 1 : 0)
  const activeVus = ticks.length > 0 ? ticks[ticks.length - 1]!.activeVus : 0
  const xs = ticks.map((t) => t.t)

  const throughput: ChartSeries[] = [
    { key: 'rps', label: 'Requests/s', color: 'var(--chart-series-1)', values: ticks.map((t) => t.rps) },
  ]
  const latency: ChartSeries[] = [
    { key: 'p50', label: 'p50', color: 'var(--chart-series-1)', values: ticks.map((t) => t.p50) },
    { key: 'p95', label: 'p95', color: 'var(--chart-series-2)', values: ticks.map((t) => t.p95) },
    { key: 'p99', label: 'p99', color: 'var(--chart-series-3)', values: ticks.map((t) => t.p99) },
  ]

  async function exportResults(): Promise<void> {
    if (!test?.finished || !test.totals) return
    const report = buildLoadReport(test.meta, {
      options: test.options,
      totals: test.totals,
      ticks: test.ticks,
      finished: test.finished,
    })
    try {
      const saved = await window.astral.load.saveReport(
        JSON.stringify(report, null, 2),
        loadReportFileName(name, test.meta.startedAt),
      )
      if (saved !== null) setExported({ ok: true, text: `Saved to ${saved}` })
    } catch (e) {
      setExported({ ok: false, text: `Could not export the results: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  const errorRate = totals?.errorRate ?? 0

  return (
    <div className="runner-results load-results">
      <div className="runner-summary load-bar" role="region" aria-label="Load test status">
        {running ? (
          <>
            <div
              className="load-progress"
              role="progressbar"
              aria-label="Elapsed"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={elapsed}
              aria-valuetext={`${elapsed} of ${duration} seconds`}
            >
              <div className="load-progress-fill" style={{ width: `${(elapsed / duration) * 100}%` }} />
            </div>
            <span className="runner-progress">{`${elapsed} s / ${duration} s`}</span>
            <span className="toolbar-spacer" />
            <button type="button" className="btn" onClick={() => void store().stopLoad(path)}>
              <Square size={12} aria-hidden="true" />
              Stop
            </button>
          </>
        ) : (
          <>
            <span
              className={`runner-reason runner-reason-${test.finished!.reason === 'completed' ? 'ok' : 'stopped'}`}
            >
              {loadReasonText(test.finished!.reason, test.finished!.message)}
            </span>
            {exported && (
              <span role={exported.ok ? 'status' : 'alert'} className={exported.ok ? 'muted' : 'runner-error'}>
                {exported.text}
              </span>
            )}
            <span className="toolbar-spacer" />
            <button
              type="button"
              className="btn"
              disabled={state.starting}
              onClick={() => onRunAgain(test.options)}
            >
              <RotateCcw size={14} aria-hidden="true" />
              Run again
            </button>
            <button type="button" className="btn" onClick={() => store().showLoadConfig(path)}>
              <Settings2 size={14} aria-hidden="true" />
              New test
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!totals}
              onClick={() => void exportResults()}
            >
              <Download size={14} aria-hidden="true" />
              Export results
            </button>
          </>
        )}
      </div>

      <div className="load-body">
        <div className="load-tiles">
          <Tile label="Requests" value={totals ? formatCount(totals.completed) : '–'} />
          <Tile label="Req/s" value={totals ? formatRps(totals.rps) : '–'} />
          <Tile label="p50" unit="ms" value={totals ? formatMs(totals.p50) : '–'} />
          <Tile label="p95" unit="ms" value={totals ? formatMs(totals.p95) : '–'} />
          <Tile label="p99" unit="ms" value={totals ? formatMs(totals.p99) : '–'} />
          <Tile label="Error rate" value={totals ? formatPercent(errorRate) : '–'} error={errorRate > 0} />
          {running && <Tile label="Active VUs" value={formatCount(activeVus)} />}
        </div>

        <div className="load-charts">
          <LineChart
            title="Throughput (req/s)"
            xs={xs}
            xMax={duration}
            series={throughput}
            unit="req/s"
            format={formatRps}
          />
          <LineChart title="Latency (ms)" xs={xs} xMax={duration} series={latency} unit="ms" format={formatMs} />
        </div>

        <div className="load-breakdowns">
          <Breakdown title="Status codes" counts={totals?.status ?? {}} empty="No responses yet" />
          <Breakdown title="Errors" counts={totals?.errorCodes ?? {}} empty="No errors" />
        </div>
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  unit,
  error,
}: {
  label: string
  value: string
  unit?: string
  error?: boolean
}): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className={`load-tile${error ? ' load-tile-error' : ''}`}>
      <span className="load-tile-value">
        {error && <CircleAlert size={16} aria-hidden="true" />}
        {value}
        {unit && value !== '–' && <span className="load-tile-unit">{` ${unit}`}</span>}
      </span>
      <span className="load-tile-label">{label}</span>
    </div>
  )
}

/** A compact table of counts by code, most frequent first, with each code's share of the table's total. */
function Breakdown({
  title,
  counts,
  empty,
}: {
  title: string
  counts: Record<string, number>
  empty: string
}): React.JSX.Element {
  const entries = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  return (
    <section className="load-breakdown" aria-label={`${title} breakdown`}>
      <h3 className="runner-heading">{title}</h3>
      {entries.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <table className="grid-table load-table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Count</th>
              <th scope="col">%</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([code, n]) => (
              <tr key={code}>
                <td>{code}</td>
                <td>{formatCount(n)}</td>
                <td>{formatPercent(n / total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
