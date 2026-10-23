import { CodeXml, X } from 'lucide-react'
import { useState } from 'react'
import { looksLikeCurl, parseCurl } from '../../../../shared/curl'
import type { HttpMethod, RequestItem } from '../../../../shared/types'
import { shortcut } from '../../lib/platform'
import { composeUrl, splitUrl } from '../../lib/url'
import { useApp } from '../../state/store'
import { Dropdown } from '../Dropdown'
import { VarInput } from '../VarInput'
import { CodeDialog } from './CodeDialog'

export const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

const METHOD_OPTIONS = METHODS.map((m) => ({ value: m, label: m, className: `method-${m.toLowerCase()}` }))

interface Props {
  path: string
  draft: RequestItem
  edit(patch: Partial<RequestItem>): void
}

/** A pasted curl command as the request's method, URL, params, headers, body and auth; its name and scripts stay. */
function fromCurl(text: string): { patch: Partial<RequestItem>; skipped: string[] } {
  const parsed = parseCurl(text)
  const { url, params } = splitUrl(parsed.url, [])
  return {
    patch: { method: parsed.method, url, params, headers: parsed.headers, body: parsed.body, auth: parsed.auth },
    skipped: parsed.skipped,
  }
}

/**
 * One box with the method and the URL, then Send (Cancel while sending) and Code. Pasting a curl command into the
 * URL replaces the request with what it describes.
 */
export function UrlBar({ path, draft, edit }: Props): React.JSX.Element {
  const sending = useApp((s) => s.responses[path]?.state === 'sending')
  const [typedUrl, setTypedUrl] = useState<string | null>(null)
  const [codeOpen, setCodeOpen] = useState(false)
  const [pasteNote, setPasteNote] = useState<{ text: string; error: boolean } | null>(null)
  const store = useApp.getState

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>): void {
    const text = e.clipboardData.getData('text/plain')
    if (!looksLikeCurl(text)) return
    e.preventDefault()
    try {
      const { patch, skipped } = fromCurl(text)
      setTypedUrl(null)
      edit(patch)
      setPasteNote(
        skipped.length > 0 ? { text: `Imported from cURL. Left out: ${skipped.join(', ')}.`, error: false } : null,
      )
    } catch (err) {
      setPasteNote({
        text: `Could not read the cURL command: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      })
    }
  }

  const composed = composeUrl(draft.url, draft.params)
  // While the user types, keep their text as long as the draft still corresponds to it (it differs once the params change).
  const split = typedUrl === null ? null : splitUrl(typedUrl, draft.params)
  const urlText = typedUrl !== null && split && composeUrl(split.url, split.params) === composed ? typedUrl : composed

  return (
    <>
      <div className="url-row">
        <div className="url-box">
          <Dropdown
            label="Method"
            className={`method-select method-${draft.method.toLowerCase()}`}
            value={draft.method}
            options={METHOD_OPTIONS}
            onChange={(method) => edit({ method })}
          />
          <VarInput
            className="url-input"
            aria-label="URL"
            placeholder="Enter URL or paste text"
            value={urlText}
            onChange={(value) => {
              setTypedUrl(value)
              edit(splitUrl(value, draft.params))
            }}
            onBlur={() => setTypedUrl(null)}
            onPaste={onPaste}
          />
        </div>
        {sending ? (
          <button type="button" className="btn send-btn send-btn-cancel" onClick={() => void store().cancelSend(path)}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary send-btn"
            title={`Send (${shortcut('↵')})`}
            onClick={() => void store().send(path)}
          >
            Send
          </button>
        )}
        <button
          type="button"
          className="icon-btn code-btn"
          aria-label="Code"
          title="Code: this request as cURL, JavaScript or Python"
          onClick={() => setCodeOpen(true)}
        >
          <CodeXml size={16} aria-hidden="true" />
        </button>
        {codeOpen && <CodeDialog path={path} onClose={() => setCodeOpen(false)} />}
      </div>
      {pasteNote && (
        <div className={`url-paste-note${pasteNote.error ? ' url-paste-note-error' : ''}`} role="status">
          <span>{pasteNote.text}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setPasteNote(null)}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  )
}
