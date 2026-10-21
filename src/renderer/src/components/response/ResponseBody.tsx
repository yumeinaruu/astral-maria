import { Braces, Check, Copy, Eye, Search, WrapText } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HttpResponse } from '../../../../shared/types'
import { formatBytes, LARGE_PREVIEW_CHARS, prettyJson, prettyXml, type DecodedBody } from '../../lib/body'
import { useApp, type BodyMode } from '../../state/store'
import { useUi } from '../../state/ui'
import { CodeEditor, type CodeEditorHandle } from '../CodeEditor'
import { Dropdown } from '../Dropdown'

type Format = 'json' | 'xml' | 'html' | 'text'
type FormatChoice = Format | 'raw'

const FORMATS: { value: FormatChoice; label: string }[] = [
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'html', label: 'HTML' },
  { value: 'text', label: 'Text' },
  { value: 'raw', label: 'Raw' },
]

function availableModes(decoded: DecodedBody): BodyMode[] {
  if (decoded.kind === 'binary' || decoded.large) return []
  if (decoded.kind === 'image') return ['preview']
  if (decoded.kind === 'html') return ['pretty', 'raw', 'preview']
  return ['pretty', 'raw']
}

function formatted(text: string, format: Format): string {
  if (format === 'json') return prettyJson(text)
  if (format === 'xml') return prettyXml(text)
  return text
}

interface Props {
  path: string
  decoded: DecodedBody
  mode: BodyMode
  response: HttpResponse
}

/** The body toolbar (format, preview, wrap, search, copy) and the body itself. */
export function ResponseBody({ path, decoded, mode, response }: Props): React.JSX.Element {
  const modes = availableModes(decoded)
  const effective = modes.includes(mode) ? mode : (modes[0] ?? 'pretty')
  const { kind, text } = decoded
  // The format picked for this response; a new response starts from its detected kind again.
  const [format, setFormat] = useState<Format | null>(null)
  const wrap = useUi((s) => s.responseWrap)
  const editor = useRef<CodeEditorHandle>(null)
  const language: Format = format ?? (kind === 'json' || kind === 'xml' || kind === 'html' ? kind : 'text')
  const setMode = (m: BodyMode): void => useApp.getState().setResponseView(path, { mode: m })
  const showsEditor = text !== undefined && !decoded.large && effective !== 'preview'
  const shown = useMemo(
    () => (!showsEditor ? '' : effective === 'pretty' ? formatted(text, language) : text),
    [showsEditor, effective, text, language],
  )

  return (
    <div className="body-view">
      <div className="body-toolbar">
        {modes.includes('pretty') && (
          <Dropdown
            label="Body format"
            icon={<Braces size={14} aria-hidden="true" />}
            value={effective === 'raw' ? 'raw' : language}
            options={FORMATS}
            onChange={(choice) => {
              if (choice === 'raw') setMode('raw')
              else {
                setFormat(choice)
                setMode('pretty')
              }
            }}
          />
        )}
        {modes.includes('preview') && modes.length > 1 && (
          <button
            type="button"
            className="btn-text toggle-text"
            aria-pressed={effective === 'preview'}
            onClick={() => setMode(effective === 'preview' ? 'pretty' : 'preview')}
          >
            <Eye size={14} aria-hidden="true" />
            Preview
          </button>
        )}
        <span className="toolbar-spacer" />
        {showsEditor && (
          <>
            <button
              type="button"
              className="icon-btn toggle-btn"
              aria-label="Wrap lines"
              title="Wrap lines"
              aria-pressed={wrap}
              onClick={() => useUi.getState().setResponseWrap(!wrap)}
            >
              <WrapText size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Search body"
              title="Search"
              onClick={() => editor.current?.openSearch()}
            >
              <Search size={15} aria-hidden="true" />
            </button>
          </>
        )}
        <CopyButton text={text} />
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
      {showsEditor && (
        <div className="response-editor">
          <CodeEditor
            ref={editor}
            label="Response body"
            readOnly
            wrap={wrap}
            onChange={noop}
            language={effective === 'raw' ? 'text' : language}
            value={shown}
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
      <span role="status" className={state === 'failed' ? 'copy-note copy-failed' : 'copy-note'}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed: clipboard not available' : ''}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label="Copy body"
        title="Copy body"
        disabled={text === undefined}
        onClick={() => void copy()}
      >
        {state === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      </button>
    </>
  )
}

/** Blocks every network load and script in the preview, whatever the app-wide CSP says. */
const PREVIEW_POLICY =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">'

/** The policy goes before any response markup (after a leading doctype, which must stay first for standards mode). */
function previewDocument(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? ''
  return doctype + PREVIEW_POLICY + html.slice(doctype.length)
}
