import { Upload } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { ImportedItem, ImportReport } from '../../../shared/types'
import { useApp } from '../state/store'
import { useUi } from '../state/ui'

const PASTED = 'Pasted text'
const FOCUSABLE = 'button:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'

function resultText(item: ImportedItem): string {
  if (item.kind === 'collection') return `Collection "${item.name}" imported`
  if (item.kind === 'environment') return `Environment "${item.name}" imported`
  return 'Globals updated'
}

function merge(reports: ImportReport[]): ImportReport {
  return {
    imported: reports.flatMap((r) => r.imported),
    failed: reports.flatMap((r) => r.failed),
  }
}

/** Opens the sidebar sections the imported items went to, so they can be seen. */
function revealSections(report: ImportReport): void {
  const ui = useUi.getState()
  if (report.imported.some((i) => i.kind === 'collection')) ui.setSectionOpen('collections', true)
  if (report.imported.some((i) => i.kind !== 'collection')) ui.setSectionOpen('environments', true)
}

/**
 * Imports Postman collections, environments and globals: dropped files, files from the open dialog, or pasted text.
 * Escape and Close close it, Tab stays inside, and focus is restored on close, as in `ConfirmDialog`.
 */
export function ImportDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const titleId = useId()
  const pasteId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const chooseRef = useRef<HTMLButtonElement>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [results, setResults] = useState<ImportReport | null>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    chooseRef.current?.focus()
    return () => previous?.focus()
  }, [])

  async function run(work: () => Promise<ImportReport | null>): Promise<ImportReport | null> {
    setBusy(true)
    try {
      const report = await work()
      if (report) {
        setResults(report)
        revealSections(report)
      }
      return report
    } finally {
      setBusy(false)
      // Disabling the focused control drops focus to the body; keep it in the dialog.
      if (!dialogRef.current?.contains(document.activeElement)) chooseRef.current?.focus()
    }
  }

  function chooseFiles(): void {
    void run(() => useApp.getState().importFiles())
  }

  function importPasted(): void {
    void run(() => useApp.getState().importText(text, PASTED)).then((report) => {
      if (report && report.imported.length > 0 && report.failed.length === 0) setText('')
    })
  }

  function onDrop(e: React.DragEvent): void {
    e.preventDefault()
    setDragging(false)
    if (busy) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    void run(async () => {
      const reports: ImportReport[] = []
      // One by one, so the reports and the writes keep the order of the files.
      for (const file of files) {
        let content: string
        try {
          content = await file.text()
        } catch (err) {
          reports.push({ imported: [], failed: [{ source: file.name, message: String(err) }] })
          continue
        }
        reports.push(await useApp.getState().importText(content, file.name))
      }
      return merge(reports)
    })
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Tab') {
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const edge = e.shiftKey ? first : last
      if (document.activeElement === edge || !dialogRef.current?.contains(document.activeElement)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="dialog import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="dialog-title">
          Import
        </h2>
        <div
          className={`import-drop${dragging ? ' dragging' : ''}`}
          data-testid="import-drop-zone"
          onDragEnter={(e) => {
            e.preventDefault()
            if (!busy) setDragging(true)
          }}
          onDragOver={(e) => {
            e.preventDefault()
            if (!busy) setDragging(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={onDrop}
        >
          <Upload size={24} strokeWidth={1.5} aria-hidden="true" />
          <span>Drop Postman files here</span>
          <button type="button" className="btn" ref={chooseRef} disabled={busy} onClick={chooseFiles}>
            Choose files
          </button>
        </div>
        <div className="import-paste">
          <label htmlFor={pasteId} className="import-label">
            Paste raw text
          </label>
          <textarea
            id={pasteId}
            className="import-textarea"
            rows={8}
            spellCheck={false}
            disabled={busy}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {results && <Results report={results} />}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || text.trim() === ''}
            onClick={importPasted}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  )
}

function Results({ report }: { report: ImportReport }): React.JSX.Element {
  return (
    <ul className="import-results" aria-label="Import results" aria-live="polite">
      {report.imported.map((item, i) => (
        <li key={`ok-${i}`} className="import-result">
          <span className="import-result-text">{resultText(item)}</span>
          {item.warnings.length > 0 && (
            <details className="import-warnings">
              <summary>{`${item.warnings.length} ${item.warnings.length === 1 ? 'warning' : 'warnings'}`}</summary>
              <ul>
                {item.warnings.map((w, j) => (
                  <li key={j}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </li>
      ))}
      {report.failed.map((f, i) => (
        <li key={`failed-${i}`} className="import-result import-failed">
          <span className="import-result-text">
            {f.source}: {f.message}
          </span>
        </li>
      ))}
    </ul>
  )
}
