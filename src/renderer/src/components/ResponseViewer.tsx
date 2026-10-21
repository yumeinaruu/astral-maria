import { CircleAlert, Download, LoaderCircle, Send } from 'lucide-react'
import { useId, useRef } from 'react'
import type { HttpResponse } from '../../../shared/types'
import {
  bodyBytes,
  decodeBody,
  formatBytes,
  formatDuration,
  headerValue,
  parseContentType,
  suggestFileName,
  type DecodedBody,
} from '../lib/body'
import { shortcut } from '../lib/platform'
import { DEFAULT_RESPONSE_VIEW, useApp, type ResponseTab } from '../state/store'
import { HoverTip } from './response/HoverTip'
import { ResponseBody } from './response/ResponseBody'
import { CookiesTable, HeadersTable } from './response/ResponseTables'

const TABS: { id: ResponseTab; label: string }[] = [
  { id: 'body', label: 'Body' },
  { id: 'cookies', label: 'Cookies' },
  { id: 'headers', label: 'Headers' },
]

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
      <div className="response-state">
        <Send size={28} strokeWidth={1.5} aria-hidden="true" />
        <p>Click Send to get a response</p>
        <p className="response-state-hint">or press {shortcut('↵')}</p>
      </div>
    )
  }
  if (entry.state === 'sending') {
    return (
      <div className="response-state">
        <LoaderCircle className="spin" size={24} strokeWidth={1.5} aria-hidden="true" />
        <p role="status">Sending…</p>
      </div>
    )
  }
  const result = entry.result!
  if (!result.ok) {
    const { code, message } = result.error
    return (
      <div className="response-state response-error" role="alert">
        <CircleAlert size={28} strokeWidth={1.5} aria-hidden="true" />
        <p className="error-title">Could not get a response</p>
        <p className="error-message">{message}</p>
        {ERROR_EXPLANATIONS[code] && <p className="error-explanation">{ERROR_EXPLANATIONS[code]}</p>}
        <p className="error-code mono">{code}</p>
      </div>
    )
  }
  return <ResponseDetails path={path} response={result.response} />
}

function ResponseDetails({ path, response }: { path: string; response: HttpResponse }): React.JSX.Element {
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

  const counts: Record<ResponseTab, number> = {
    body: 0,
    headers: response.headers.length,
    cookies: response.cookies.length,
  }

  return (
    <div className="response-viewer">
      <div className="response-head">
        <div className="pill-tabs" role="tablist" aria-label="Response sections">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${idBase}-${t.id}`}
              aria-selected={view.tab === t.id}
              aria-controls={`${idBase}-panel`}
              tabIndex={view.tab === t.id ? 0 : -1}
              className="pill-tab"
              onClick={() => useApp.getState().setResponseView(path, { tab: t.id })}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {t.label}
              {counts[t.id] > 0 && <span className="pill-count"> {counts[t.id]}</span>}
            </button>
          ))}
        </div>
        <ResponseMeta response={response} decoded={decoded} />
      </div>
      {response.redirects > 0 && (
        <div className="redirect-line">
          <span>{response.redirects === 1 ? '1 redirect' : `${response.redirects} redirects`}</span>
          <span className="final-url mono" title={response.finalUrl}>
            {response.finalUrl}
          </span>
        </div>
      )}
      <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-${view.tab}`} className="response-panel">
        {view.tab === 'body' && (
          <ResponseBody
            // A different response starts with fresh copy feedback and its own detected format.
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

/** Status pill, time and size with their tooltips, then save. */
function ResponseMeta({ response, decoded }: { response: HttpResponse; decoded: DecodedBody }): React.JSX.Element {
  const headerBytes = response.headers.reduce((n, [k, v]) => n + k.length + v.length + 4, 0)
  return (
    <div className="response-meta">
      <span className={`status-badge ${statusClass(response.status)}`}>
        {`${response.status} ${response.statusText}`.trim()}
      </span>
      <span className="meta-dot" aria-hidden="true" />
      <HoverTip
        tip={
          <span className="tip-rows">
            <span>Total time</span>
            <span className="mono">{formatDuration(response.totalMs)}</span>
          </span>
        }
      >
        {formatDuration(response.totalMs)}
      </HoverTip>
      <span className="meta-dot" aria-hidden="true" />
      <HoverTip
        tip={
          <span className="tip-rows">
            <span>Headers</span>
            <span className="mono">~{formatBytes(headerBytes)}</span>
            <span>Body</span>
            <span className="mono">{formatBytes(response.sizeBytes)}</span>
            {response.bodyTruncated && (
              <>
                <span>Received</span>
                <span className="mono">{formatBytes(decoded.byteLength)}</span>
              </>
            )}
          </span>
        }
      >
        {formatBytes(response.sizeBytes)}
      </HoverTip>
      <button
        type="button"
        className="icon-btn"
        aria-label="Save body as file"
        title="Save body as file"
        onClick={() => saveBody(response)}
      >
        <Download size={15} aria-hidden="true" />
      </button>
    </div>
  )
}

function useMemoDecoded(response: HttpResponse): DecodedBody {
  const cache = useRef<{ response: HttpResponse; decoded: DecodedBody } | null>(null)
  if (cache.current?.response !== response) cache.current = { response, decoded: decodeBody(response) }
  return cache.current.decoded
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
