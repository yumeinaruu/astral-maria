import { useEffect, useId, useRef, useState } from 'react'
import type { HttpResponse, ParsedCookie } from '../../../shared/types'
import {
  bodyBytes,
  decodeBody,
  parseContentType,
  headerValue,
  formatBytes,
  formatDuration,
  LARGE_PREVIEW_CHARS,
  prettyJson,
  suggestFileName,
  type DecodedBody,
} from '../lib/body'
import { DEFAULT_RESPONSE_VIEW, useApp, type BodyMode, type ResponseTab } from '../state/store'
import { CodeEditor, type CodeLanguage } from './CodeEditor'

const TABS: { id: ResponseTab; label: string }[] = [
  { id: 'body', label: 'Body' },
  { id: 'headers', label: 'Headers' },
  { id: 'cookies', label: 'Cookies' },
]

const MODE_LABELS: Record<BodyMode, string> = { pretty: 'Pretty', raw: 'Raw', preview: 'Preview' }

const ERROR_EXPLANATIONS: Record<string, string> = {
  dns_failed: 'The host name could not be resolved. Check the spelling of the URL and your network connection.',
  connection_refused: 'The server refused the connection. Check the host, the port and that the server is running.',
  tls_error:
    'The secure connection could not be established. The certificate or the TLS settings of the server are not accepted.',
  timeout: 'The server did not answer in time.',
  too_many_redirects: 'The request was redirected too many times; the redirects probably loop.',
  cancelled: 'The request was cancelled before a response arrived.',
  invalid_url: 'The URL is not valid. Check that it starts with http:// or https:// and has a host.',
  network_error: 'The request failed because of a network problem.',
}

function statusClass(status: number): string {
  if (status >= 500) return 'status-5xx'
  if (status >= 400) return 'status-4xx'
  if (status >= 300) return 'status-3xx'
  if (status >= 200) return 'status-2xx'
  return 'status-other'
}

export function ResponseViewer({ path }: { path: string }): React.JSX.Element {
  const entry = useApp((s) => s.responses[path])

  if (!entry || entry.state === 'idle' || (entry.state === 'done' && !entry.result)) {
    return (
      <p className="muted response-empty">
        Send the request to see the response. Press <kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> to send from anywhere in the
        editor.
      </p>
    )
  }
  if (entry.state === 'sending') {
    return (
      <p role="status" className="muted">
        Sending…
      </p>
    )
  }
  const result = entry.result!
  if (!result.ok) {
    const { code, message } = result.error
    return (
      <div className="error-panel" role="alert">
        <p className="error-code mono">{code}</p>
        <p className="error-message">{message}</p>
        {ERROR_EXPLANATIONS[code] && <p className="muted">{ERROR_EXPLANATIONS[code]}</p>}
      </div>
    )
  }
  return <ResponseDetails path={path} response={result.response} />
}

interface DetailsProps {
  path: string
  response: HttpResponse
}

function ResponseDetails({ path, response }: DetailsProps): React.JSX.Element {
  const view = useApp((s) => s.responseViews[path]) ?? DEFAULT_RESPONSE_VIEW
  const idBase = useId()
  const decoded = useMemoDecoded(response)

  function select(tab: ResponseTab): void {
    useApp.getState().setResponseView(path, { tab })
    document.getElementById(`${idBase}-${tab}`)?.focus()
  }

  function onKeyDown(e: React.KeyboardEvent, index: number): void {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    select(TABS[(index + step + TABS.length) % TABS.length]!.id)
  }

  const counts: Record<ResponseTab, number | null> = {
    body: null,
    headers: response.headers.length,
    cookies: response.cookies.length,
  }

  return (
    <div className="response-viewer">
      <div className="response-summary">
        <span className={`status-badge ${statusClass(response.status)}`}>
          {`${response.status} ${response.statusText}`.trim()}
        </span>
        <span>{formatDuration(response.totalMs)}</span>
        <span>{formatBytes(response.sizeBytes)}</span>
        {response.redirects > 0 && (
          <>
            <span>{response.redirects === 1 ? '1 redirect' : `${response.redirects} redirects`}</span>
            <span className="final-url mono" title={response.finalUrl}>
              {response.finalUrl}
            </span>
          </>
        )}
      </div>

      <div className="section-tabs" role="tablist" aria-label="Response sections">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${idBase}-${t.id}`}
            aria-selected={view.tab === t.id}
            aria-controls={`${idBase}-panel`}
            tabIndex={view.tab === t.id ? 0 : -1}
            className="section-tab"
            onClick={() => useApp.getState().setResponseView(path, { tab: t.id })}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
            {counts[t.id] ? <span className="section-count"> ({counts[t.id]})</span> : null}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-${view.tab}`} className="response-panel">
        {view.tab === 'body' && (
          <BodyPanel
            // A different response starts with fresh copy/save feedback.
            key={response.bodyBase64.length + ':' + response.totalMs + ':' + response.status}
            path={path}
            response={response}
            decoded={decoded}
            mode={view.mode}
          />
        )}
        {view.tab === 'headers' && <HeadersTable headers={response.headers} />}
        {view.tab === 'cookies' && <CookiesTable cookies={response.cookies} />}
      </div>
    </div>
  )
}

function useMemoDecoded(response: HttpResponse): DecodedBody {
  const cache = useRef<{ response: HttpResponse; decoded: DecodedBody } | null>(null)
  if (cache.current?.response !== response) cache.current = { response, decoded: decodeBody(response) }
  return cache.current.decoded
}

function availableModes(decoded: DecodedBody): BodyMode[] {
  if (decoded.kind === 'binary' || decoded.large) return []
  if (decoded.kind === 'image') return ['preview']
  if (decoded.kind === 'html') return ['pretty', 'raw', 'preview']
  return ['pretty', 'raw']
}

interface BodyPanelProps {
  path: string
  response: HttpResponse
  decoded: DecodedBody
  mode: BodyMode
}

function BodyPanel({ path, response, decoded, mode }: BodyPanelProps): React.JSX.Element {
  const group = useId()
  const modes = availableModes(decoded)
  const effective = modes.includes(mode) ? mode : (modes[0] ?? 'pretty')
  const { kind, text } = decoded

  return (
    <div className="body-view">
      <div className="body-toolbar">
        {modes.length > 1 && (
          <fieldset className="radio-row mode-switch">
            <legend className="sr-only">Body view</legend>
            {modes.map((m) => (
              <label key={m} className="radio">
                <input
                  type="radio"
                  name={group}
                  checked={effective === m}
                  onChange={() => useApp.getState().setResponseView(path, { mode: m })}
                />
                {MODE_LABELS[m]}
              </label>
            ))}
          </fieldset>
        )}
        <span className="toolbar-spacer" />
        <CopyButton text={text} />
        <button type="button" className="btn" onClick={() => saveBody(response)}>
          Save body as file
        </button>
      </div>

      {response.bodyTruncated && (
        <p className="notice">
          Response was cut at {formatBytes(decoded.byteLength)}; actual size {formatBytes(response.sizeBytes)}.
        </p>
      )}

      {text === undefined && kind === 'binary' && (
        <p className="notice">
          Binary response{decoded.mime ? ` (${decoded.mime})` : ''}, {formatBytes(decoded.byteLength)}. It cannot be
          shown as text; use Save body as file to keep it.
        </p>
      )}
      {kind === 'image' && decoded.dataUrl && (
        <div className="image-preview">
          <img src={decoded.dataUrl} alt="Response body" />
        </div>
      )}
      {text !== undefined && decoded.large && (
        <>
          <p className="notice">
            Large response: showing first {formatBytes(LARGE_PREVIEW_CHARS)} of {formatBytes(decoded.byteLength)}
          </p>
          <pre className="large-body mono">{text.slice(0, LARGE_PREVIEW_CHARS)}</pre>
        </>
      )}
      {text !== undefined && !decoded.large && effective === 'preview' && kind === 'html' && (
        <>
          <iframe className="html-preview" title="HTML preview" sandbox="" srcDoc={previewDocument(text)} />
          <p className="muted note">Remote resources are blocked.</p>
        </>
      )}
      {text !== undefined && !decoded.large && effective !== 'preview' && (
        <div className="response-editor">
          <CodeEditor
            label="Response body"
            readOnly
            onChange={noop}
            language={effective === 'raw' ? 'text' : (kind as CodeLanguage)}
            value={effective === 'pretty' && kind === 'json' ? prettyJson(text) : text}
          />
        </div>
      )}
    </div>
  )
}

function noop(): void {}

function CopyButton({ text }: { text: string | undefined }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  async function copy(): Promise<void> {
    if (timer.current) clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(text ?? '')
      setState('copied')
      timer.current = setTimeout(() => setState('idle'), 1500)
    } catch {
      setState('failed')
    }
  }

  return (
    <>
      <button type="button" className="btn" disabled={text === undefined} onClick={() => void copy()}>
        Copy body
      </button>
      <span role="status" className={state === 'failed' ? 'copy-note copy-failed' : 'copy-note'}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed: clipboard not available' : ''}
      </span>
    </>
  )
}

/** Downloads the body through a temporary link to an object URL; no IPC involved. */
function saveBody(response: HttpResponse): void {
  const bytes = bodyBytes(response)
  const mime = parseContentType(headerValue(response, 'content-type')).mime
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime || 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  try {
    link.href = url
    link.download = suggestFileName(response)
    link.hidden = true
    document.body.append(link)
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

/** Blocks every network load and script in the preview, whatever the app-wide CSP says. */
const PREVIEW_POLICY =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">'

/** The policy goes before any response markup (after a leading doctype, which must stay first for standards mode). */
function previewDocument(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? ''
  return doctype + PREVIEW_POLICY + html.slice(doctype.length)
}

function HeadersTable({ headers }: { headers: [string, string][] }): React.JSX.Element {
  if (headers.length === 0) return <p className="muted">No headers.</p>
  return (
    <table className="kv-table response-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {headers.map(([name, value], i) => (
          <tr key={i}>
            <td className="mono">{name}</td>
            <td className="mono">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const FLAGS = ['httponly', 'secure']

function CookiesTable({ cookies }: { cookies: ParsedCookie[] }): React.JSX.Element {
  if (cookies.length === 0) return <p className="muted">No cookies.</p>
  return (
    <table className="kv-table response-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Value</th>
          <th scope="col">Attributes</th>
        </tr>
      </thead>
      <tbody>
        {cookies.map((c, i) => {
          const entries = Object.entries(c.attributes)
          const flags = entries.filter(([k]) => FLAGS.includes(k.toLowerCase()))
          const others = entries.filter(([k]) => !FLAGS.includes(k.toLowerCase()))
          return (
            <tr key={i}>
              <td className="mono">{c.name}</td>
              <td className="mono">{c.value}</td>
              <td className="cookie-attrs">
                {flags.map(([k]) => (
                  <span key={k} className="flag">
                    {k}
                  </span>
                ))}
                {others.length > 0 && (
                  <span className="mono muted">
                    {others.map(([k, v]) => (v === true ? k : `${k}=${v}`)).join('; ')}
                  </span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
