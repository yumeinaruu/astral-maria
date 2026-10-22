import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ScriptLog } from '../../../shared/types'
import { formatDuration } from '../lib/body'
import { useApp, type ConsoleLine } from '../state/store'
import { useUi } from '../state/ui'
import { Dropdown, type DropdownOption } from './Dropdown'

type LevelFilter = 'all' | ScriptLog['level']

const LEVELS: DropdownOption<LevelFilter>[] = [
  { value: 'all', label: 'All levels' },
  { value: 'log', label: 'Log' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warnings' },
  { value: 'error', label: 'Errors' },
  { value: 'debug', label: 'Debug' },
]

const KEY_STEP = 20

/** Request lines always show, so the log lines keep their context; a failed script counts as an error. */
function visible(line: ConsoleLine, filter: LevelFilter): boolean {
  if (filter === 'all' || line.kind === 'request') return true
  return (line.kind === 'failure' ? 'error' : line.level) === filter
}

/** The bottom panel with what the sends of this session did: the request, the scripts' console output and failures. */
export function ConsolePanel(): React.JSX.Element {
  const lines = useApp((s) => s.consoleLines)
  const height = useUi((s) => s.consoleHeight)
  const [filter, setFilter] = useState<LevelFilter>('all')
  const list = useRef<HTMLOListElement>(null)
  const drag = useRef<{ y: number; height: number } | null>(null)
  const shown = lines.filter((l) => visible(l, filter))

  // Newest last: follow the end as lines arrive.
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  const resize = (h: number): void => useUi.getState().setConsoleHeight(h)

  function onKeyDown(e: React.KeyboardEvent): void {
    const step = e.key === 'ArrowUp' ? KEY_STEP : e.key === 'ArrowDown' ? -KEY_STEP : 0
    if (step === 0) return
    e.preventDefault()
    resize(height + step)
  }

  return (
    <section className="console-panel" aria-label="Console" style={{ height: `${height}px` }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize console"
        aria-valuenow={height}
        tabIndex={0}
        className="console-resize"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { y: e.clientY, height }
        }}
        onPointerMove={(e) => {
          if (drag.current && e.currentTarget.hasPointerCapture(e.pointerId)) {
            resize(drag.current.height + drag.current.y - e.clientY)
          }
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId)
          drag.current = null
        }}
        onKeyDown={onKeyDown}
      />
      <div className="console-head">
        <span className="console-title">Console</span>
        <Dropdown<LevelFilter>
          label="Console level"
          className="btn-text"
          value={filter}
          options={LEVELS}
          onChange={setFilter}
        />
        <span className="toolbar-spacer" />
        <button type="button" className="btn-text" onClick={() => useApp.getState().clearConsole()}>
          Clear
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close console"
          title="Close console"
          onClick={() => useUi.getState().toggleConsole()}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      {lines.length === 0 ? (
        <p className="console-empty">No output yet. Send a request to see it here with its scripts&apos; logs.</p>
      ) : (
        <ol className="console-lines mono" ref={list} aria-label="Console output">
          {shown.map((line) => (
            <ConsoleRow key={line.id} line={line} />
          ))}
        </ol>
      )}
    </section>
  )
}

function ConsoleRow({ line }: { line: ConsoleLine }): React.JSX.Element {
  if (line.kind === 'request') {
    const ok = line.status !== undefined
    return (
      <li className="console-line console-request">
        <span className={`console-method method-${line.method.toLowerCase()}`}>{line.method}</span>{' '}
        <span className="console-url">{line.url}</span>{' '}
        {ok ? (
          <>
            <span className={line.status! >= 400 ? 'console-status-bad' : 'console-status'}>{line.status}</span>{' '}
            <span className="console-meta">{formatDuration(line.ms ?? 0)}</span>
          </>
        ) : (
          <span className="console-status-bad">{line.error}</span>
        )}
      </li>
    )
  }
  const level = line.kind === 'failure' ? 'error' : line.level
  return (
    <li className={`console-line console-${level}${line.kind === 'failure' ? ' console-failure' : ''}`}>
      <span className="console-level">{level}</span>
      <span className="console-text">{line.kind === 'failure' ? `Script error: ${line.message}` : line.text}</span>
      <span className="console-meta">{`${line.phase} · ${line.source}`}</span>
    </li>
  )
}
