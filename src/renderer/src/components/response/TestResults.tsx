import { FlaskConical } from 'lucide-react'
import { useState } from 'react'
import type { ScriptTest } from '../../../../shared/types'

type Filter = 'all' | 'passed' | 'skipped' | 'failed'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'passed', label: 'Passed' },
  { id: 'skipped', label: 'Skipped' },
  { id: 'failed', label: 'Failed' },
]

type Outcome = Exclude<Filter, 'all'>

function outcome(test: ScriptTest): Outcome {
  return test.skipped ? 'skipped' : test.passed ? 'passed' : 'failed'
}

const BADGES: Record<Outcome, { text: string; className: string }> = {
  passed: { text: 'PASS', className: 'test-pass' },
  failed: { text: 'FAIL', className: 'test-fail' },
  skipped: { text: 'SKIP', className: 'test-skip' },
}

/** `passed/total` for the tab label, or null when the send ran no tests. Skipped tests count in the total. */
export function testSummary(tests: ScriptTest[] | undefined): string | null {
  if (!tests || tests.length === 0) return null
  return `${tests.filter((t) => outcome(t) === 'passed').length}/${tests.length}`
}

export function TestResults({ tests }: { tests: ScriptTest[] }): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('all')

  if (tests.length === 0) {
    return (
      <div className="response-state">
        <FlaskConical size={28} strokeWidth={1.5} aria-hidden="true" />
        <p>No tests for this request</p>
        <p className="response-state-hint">Write tests in the Scripts tab with pm.test()</p>
      </div>
    )
  }

  const shown = filter === 'all' ? tests : tests.filter((t) => outcome(t) === filter)
  return (
    <div className="test-results">
      <div className="test-filter" role="group" aria-label="Filter tests">
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
      {shown.length === 0 ? (
        <p className="muted panel-empty">{`No ${filter} tests`}</p>
      ) : (
        <ul className="test-list" aria-label="Test results">
          {shown.map((t, i) => {
            const badge = BADGES[outcome(t)]
            return (
              <li key={i} className="test-row">
                <span className={`test-badge ${badge.className}`}>{badge.text}</span>
                <div className="test-text">
                  <span className="test-name">{t.name}</span>
                  {outcome(t) === 'failed' && t.error && <span className="test-error">{t.error}</span>}
                </div>
                <span className="test-source">{t.source}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
