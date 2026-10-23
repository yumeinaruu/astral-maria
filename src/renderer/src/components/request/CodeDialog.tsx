import { Check, Copy } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { SnippetLanguage } from '../../../../shared/types'
import { oneOf, readPref, writePref } from '../../lib/prefs'
import { useApp } from '../../state/store'
import { CodeEditor, type CodeLanguage } from '../CodeEditor'
import { Dropdown } from '../Dropdown'

const LANGUAGES: { value: SnippetLanguage; label: string; editor: CodeLanguage }[] = [
  { value: 'curl', label: 'cURL', editor: 'text' },
  { value: 'fetch', label: 'JavaScript – fetch', editor: 'javascript' },
  { value: 'python', label: 'Python – requests', editor: 'text' },
]

const LANGUAGE_KEY = 'snippetLanguage'
const isLanguage = oneOf<SnippetLanguage>('curl', 'fetch', 'python')

const FOCUSABLE = 'button:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

type Snippet = { state: 'loading' } | { state: 'ready'; text: string } | { state: 'failed'; message: string }

/**
 * The request (its draft, as edited) as code in the chosen language. Escape and Close close it, Tab stays inside and
 * focus is restored on close, as in `ImportDialog`. The language is remembered on this machine.
 */
export function CodeDialog({ path, onClose }: { path: string; onClose(): void }): React.JSX.Element {
  const titleId = useId()
  const noteId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [language, setLanguage] = useState<SnippetLanguage>(() => readPref(LANGUAGE_KEY, 'curl', isLanguage))
  const [snippet, setSnippet] = useState<Snippet>({ state: 'loading' })
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const draft = useApp((s) => s.drafts[path])
  const environmentId = useApp((s) => s.activeEnvironmentId)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => previous?.focus()
  }, [])

  useEffect(() => {
    let current = true
    useApp
      .getState()
      .requestSnippet(path, language)
      .then(
        (text) =>
          current &&
          setSnippet(text === null ? { state: 'failed', message: 'The request is closed' } : { state: 'ready', text }),
        (e: unknown) => current && setSnippet({ state: 'failed', message: e instanceof Error ? e.message : String(e) }),
      )
    return () => {
      current = false
    }
  }, [path, language, draft, environmentId])

  useEffect(() => {
    if (copied !== 'copied') return
    const timer = setTimeout(() => setCopied('idle'), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  function choose(next: SnippetLanguage): void {
    setLanguage(next)
    writePref(LANGUAGE_KEY, next)
    setCopied('idle')
  }

  async function copy(): Promise<void> {
    if (snippet.state !== 'ready') return
    try {
      await navigator.clipboard.writeText(snippet.text)
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
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

  const editorLanguage = LANGUAGES.find((l) => l.value === language)?.editor ?? 'text'

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="dialog code-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={noteId}
        aria-busy={snippet.state === 'loading'}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="code-dialog-head">
          <h2 id={titleId} className="dialog-title">
            Code
          </h2>
          <Dropdown label="Language" value={language} options={LANGUAGES} onChange={choose} />
        </div>
        <p id={noteId} className="code-dialog-note">
          Variables are filled in from the active environment, secrets included. Scripts are not run.
        </p>
        {snippet.state === 'failed' ? (
          <p className="code-dialog-error" role="alert">
            Could not generate the code: {snippet.message}
          </p>
        ) : (
          <div className="code-dialog-code">
            <CodeEditor
              value={snippet.state === 'ready' ? snippet.text : ''}
              language={editorLanguage}
              onChange={() => {}}
              readOnly
              wrap={false}
              label={`Request as ${LANGUAGES.find((l) => l.value === language)?.label ?? language}`}
            />
          </div>
        )}
        <div className="dialog-actions">
          <span role="status" className={copied === 'failed' ? 'copy-note copy-failed' : 'copy-note'}>
            {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed: clipboard not available' : ''}
          </span>
          <button type="button" className="btn" ref={closeRef} onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={snippet.state !== 'ready'}
            onClick={() => void copy()}
          >
            {copied === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
            Copy
          </button>
        </div>
      </div>
    </div>
  )
}
