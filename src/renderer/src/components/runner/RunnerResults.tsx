import { CircleAlert, Download, RotateCcw, Settings2, Square } from 'lucide-react'
import { useState } from 'react'
import type { RunResult, ScriptTest, StopReason } from '../../../../shared/types'
import { formatBytes, formatDuration } from '../../lib/body'
import { averageTime, buildReport, isFailedResult, reportFileName, testCounts } from '../../lib/runReport'
import { useApp, type RunnerState } from '../../state/store'
import { MethodBadge } from '../MethodBadge'
import { statusClass } from '../ResponseViewer'

type Filter = 'all' | 'passed' | 'failed'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'passed', label: 'Passed' },
  { id: 'failed', label: 'Failed' },
]

/** How the end of a run reads in the results. */
export function reasonText(reason: StopReason): string {
  switch (reason) {
    case 'completed':
      return 'Completed'
    case 'stopped':
      return 'Stopped'
    case 'error':
      return 'Stopped after a failed test or request'
    case 'loop_guard':
      return 'Stopped: too many requests in one iteration'
  }
  const missing = /^next_request_not_found: (.*)$/.exec(reason)
  return missing ? `Next request ${missing[1]} not found` : reason
}

const BADGES = {
  passed: { text: 'PASS', className: 'test-pass' },
  failed: { text: 'FAIL', className: 'test-fail' },
  skipped: { text: 'SKIP', className: 'test-skip' },
} as const

function outcome(test: ScriptTest): keyof typeof BADGES {
  return test.skipped ? 'skipped' : test.passed ? 'passed' : 'failed'
}

/** The live and final results of a Runner tab's run. */
export function RunnerResults({ path, name, state }: { path: string; name: string; state: RunnerState }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(null)
  const run = state.run
  if (!run) return <p className="muted panel-empty">No run yet</p>

  const running = run.finished === null
  const counts = testCounts(run.results)
  const store = useApp.getState
  const shown = filter === 'all' ? run.results : run.results.filter((r) => (filter === 'failed') === isFailedResult(r))
  const iterations = new Map<number, RunResult[]>()
  for (const r of shown) iterations.set(r.iteration, [...(iterations.get(r.iteration) ?? []), r])

  async function exportResults(): Promise<void> {
    if (!run?.finished) return
    const report = buildReport(run.meta, run.results, run.finished)
    try {
      const saved = await window.astral.runner.saveReport(
        JSON.stringify(report, null, 2),
        reportFileName(name, run.meta.startedAt),
      )
      if (saved !== null) setExported({ ok: true, text: `Saved to ${saved}` })
    } catch (e) {
      setExported({ ok: false, text: `Could not export the results: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  return (
    <div className="runner-results">
      <div className="runner-summary" role="region" aria-label="Run summary">
        <span className="runner-stat">
          <span className="runner-stat-label">Iterations</span> <strong>{run.options.iterations}</strong>
        </span>
        <span className="runner-stat">
          <span className="runner-stat-label">Duration</span>{' '}
          <strong>{run.finished ? formatDuration(run.finished.durationMs) : '–'}</strong>
        </span>
        <span className="runner-stat">
          <span className="runner-stat-label">Avg. response time</span>{' '}
          <strong>{run.results.length > 0 ? formatDuration(averageTime(run.results)) : '–'}</strong>
        </span>
        <span className="runner-passed">{`${counts.passed} passed`}</span>
        <span className="runner-failed">{`${counts.failed} failed`}</span>
        {counts.skipped > 0 && <span className="runner-skipped">{`${counts.skipped} skipped`}</span>}
        {running && (
          <span className="runner-progress" aria-label="Progress">{`${run.results.length} / ${run.total}`}</span>
        )}
        <span className="toolbar-spacer" />
        {running ? (
          <button type="button" className="btn" onClick={() => void store().stopRun(path)}>
            <Square size={12} aria-hidden="true" />
            Stop
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              disabled={state.starting}
              onClick={() => void store().startRun(path, run.options)}
            >
              <RotateCcw size={14} aria-hidden="true" />
              Run again
            </button>
            <button type="button" className="btn" onClick={() => store().showRunnerConfig(path)}>
              <Settings2 size={14} aria-hidden="true" />
              New run
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void exportResults()}>
              <Download size={14} aria-hidden="true" />
              Export results
            </button>
          </>
        )}
      </div>

      <div className="runner-results-bar">
        <div className="test-filter" role="group" aria-label="Filter results">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="pill-tab"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {run.finished && (
          <span className={`runner-reason runner-reason-${run.finished.reason === 'completed' ? 'ok' : 'stopped'}`}>
            {reasonText(run.finished.reason)}
          </span>
        )}
        {exported && (
          <span role={exported.ok ? 'status' : 'alert'} className={exported.ok ? 'muted' : 'runner-error'}>
            {exported.text}
          </span>
        )}
      </div>

      <div className="runner-groups">
        {shown.length === 0 && (
          <p className="muted panel-empty">
            {run.results.length > 0
              ? `No ${filter} requests`
              : running
                ? 'Waiting for the first result…'
                : 'Nothing ran'}
          </p>
        )}
        {[...iterations].map(([iteration, results]) => (
          <section key={iteration} role="group" aria-label={`Iteration ${iteration + 1}`} className="runner-group">
            <h3 className="runner-group-head">{`Iteration ${iteration + 1}`}</h3>
            <ul className="runner-list">
              {results.map((r, i) => (
                <ResultRow key={`${r.path}-${i}`} result={r} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

function ResultRow({ result: r }: { result: RunResult }): React.JSX.Element {
  return (
    <li className="runner-item" aria-label={`${r.method} ${r.name}`}>
      <div className="runner-row">
        <MethodBadge method={r.method} />
        <span className="runner-name">{r.name}</span>
        <span className="runner-url" title={r.url}>
          {r.url}
        </span>
        <span className="runner-meta">
          {r.status !== undefined && (
            <span className={`status-badge ${statusClass(r.status)}`}>
              {`${r.status}${r.statusText ? ` ${r.statusText}` : ''}`}
            </span>
          )}
          {r.timeMs !== undefined && <span className="mono">{formatDuration(r.timeMs)}</span>}
          {r.sizeBytes !== undefined && <span className="mono">{formatBytes(r.sizeBytes)}</span>}
        </span>
      </div>
      {r.tests.length > 0 && (
        <ul className="runner-tests" aria-label={`Tests of ${r.name}`}>
          {r.tests.map((t, i) => {
            const badge = BADGES[outcome(t)]
            return (
              <li key={i} className="runner-test">
                <span className={`test-badge ${badge.className}`}>{badge.text}</span>
                <span className="test-text">
                  <span className="test-name">{t.name}</span>
                  {outcome(t) === 'failed' && t.error && <span className="test-error">{t.error}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {r.failures.map((f, i) => (
        <p key={i} className="runner-failure">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{`Error in ${f.phase} script of ${f.source}: ${f.message}`}</span>
        </p>
      ))}
      {r.error !== undefined && (
        <p className="runner-failure">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{r.error}</span>
        </p>
      )}
    </li>
  )
}
