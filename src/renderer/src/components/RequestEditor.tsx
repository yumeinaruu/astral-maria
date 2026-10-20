import { useId, useRef, useState } from 'react'
import type { Auth, HttpMethod, RequestBody, RequestItem } from '../../../shared/types'
import { composeUrl, splitUrl } from '../lib/url'
import { useApp } from '../state/store'
import { CodeEditor } from './CodeEditor'
import { KeyValueTable } from './KeyValueTable'
import { ResponseViewer } from './ResponseViewer'

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const SECTIONS = ['Params', 'Headers', 'Body', 'Auth'] as const
type Section = (typeof SECTIONS)[number]

const BODY_MODES: { mode: RequestBody['mode']; label: string }[] = [
  { mode: 'none', label: 'None' },
  { mode: 'raw', label: 'Raw' },
  { mode: 'urlencoded', label: 'x-www-form-urlencoded' },
  { mode: 'formdata', label: 'form-data' },
]

const AUTH_TYPES: { type: Auth['type']; label: string }[] = [
  { type: 'inherit', label: 'Inherit from parent' },
  { type: 'none', label: 'No auth' },
  { type: 'bearer', label: 'Bearer token' },
  { type: 'basic', label: 'Basic auth' },
  { type: 'apikey', label: 'API key' },
]

const EMPTY_BODIES: { [M in RequestBody['mode']]: Extract<RequestBody, { mode: M }> } = {
  none: { mode: 'none' },
  raw: { mode: 'raw', language: 'text', content: '' },
  urlencoded: { mode: 'urlencoded', fields: [] },
  formdata: { mode: 'formdata', fields: [] },
}

const EMPTY_AUTHS: { [T in Auth['type']]: Extract<Auth, { type: T }> } = {
  inherit: { type: 'inherit' },
  none: { type: 'none' },
  bearer: { type: 'bearer', token: '' },
  basic: { type: 'basic', username: '', password: '' },
  apikey: { type: 'apikey', key: '', value: '', in: 'header' },
}

/**
 * The body and auth settings a request had before the user switched to another mode, so switching back within the
 * session does not lose them. Keyed by request id; intentionally not persisted.
 */
const switchedAway = new Map<string, RequestBody | Auth>()

function remember(id: string, kind: 'body' | 'auth', value: RequestBody | Auth): void {
  switchedAway.set(`${id}:${kind}:${'mode' in value ? value.mode : value.type}`, value)
}

function recall<T extends RequestBody | Auth>(id: string, kind: 'body' | 'auth', variant: string, fallback: T): T {
  return (switchedAway.get(`${id}:${kind}:${variant}`) as T | undefined) ?? fallback
}

export function RequestEditor({ path }: { path: string }): React.JSX.Element {
  const draft = useApp((s) => s.drafts[path])
  const save = useApp((s) => s.saves[path])
  const sending = useApp((s) => s.responses[path]?.state === 'sending')
  const [section, setSection] = useState<Section>('Params')
  const [typedUrl, setTypedUrl] = useState<string | null>(null)
  const [responseShare, setShare] = useState(0.4)
  const editorRef = useRef<HTMLDivElement>(null)
  const sectionId = useId()

  if (!draft) return <p className="muted editor-loading">Loading request…</p>

  const store = useApp.getState
  const edit = (patch: Partial<RequestItem>): void => store().editDraft(path, (r) => ({ ...r, ...patch }))

  const composed = composeUrl(draft.url, draft.params)
  // While the user types, keep their text as long as the draft still corresponds to it (it differs once the params change).
  const split = typedUrl === null ? null : splitUrl(typedUrl, draft.params)
  const urlText = typedUrl !== null && split && composeUrl(split.url, split.params) === composed ? typedUrl : composed

  function onKeyDown(e: React.KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      if (!sending) void store().send(path)
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void store().saveNow(path)
    }
  }

  return (
    <div className="request-editor" ref={editorRef} onKeyDown={onKeyDown}>
      <div className="request-pane">
        <div className="request-head">
          <input
            key={draft.name}
            className="text-input request-title"
            type="text"
            aria-label="Request name"
            defaultValue={draft.name}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else if (e.key === 'Escape') {
                e.currentTarget.value = draft.name
                e.currentTarget.blur()
              }
            }}
            onBlur={(e) => {
              const name = e.currentTarget.value.trim()
              if (name && name !== draft.name) void store().rename(path, name)
              else e.currentTarget.value = draft.name
            }}
          />
          <span
            role="status"
            className={`save-status${save?.state === 'failed' ? ' save-status-failed' : ''}`}
            title={save?.error}
          >
            {save === undefined
              ? 'Saved'
              : save.state === 'failed'
                ? `Save failed: ${save.error ?? 'unknown error'}`
                : 'Saving…'}
          </span>
        </div>

        <div className="url-row">
          <select
            className={`method-select method-${draft.method.toLowerCase()}`}
            aria-label="Method"
            value={draft.method}
            onChange={(e) => edit({ method: e.target.value as HttpMethod })}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            className="text-input url-input mono"
            type="text"
            aria-label="URL"
            placeholder="https://example.com/path"
            value={urlText}
            spellCheck={false}
            onChange={(e) => {
              setTypedUrl(e.target.value)
              edit(splitUrl(e.target.value, draft.params))
            }}
            onBlur={() => setTypedUrl(null)}
          />
          {sending ? (
            <button type="button" className="btn" onClick={() => void store().cancelSend()}>
              Cancel
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => void store().send(path)}>
              Send
            </button>
          )}
        </div>

        <SectionTabs idBase={sectionId} section={section} onSelect={setSection} draft={draft} />
        <div
          role="tabpanel"
          id={`${sectionId}-panel`}
          aria-labelledby={`${sectionId}-${section}`}
          className="section-panel"
        >
          {section === 'Params' && (
            <KeyValueTable noun="param" rows={draft.params} onChange={(params) => edit({ params })} />
          )}
          {section === 'Headers' && (
            <KeyValueTable noun="header" rows={draft.headers} onChange={(headers) => edit({ headers })} />
          )}
          {section === 'Body' && <BodyPanel draft={draft} edit={edit} />}
          {section === 'Auth' && <AuthPanel draft={draft} edit={edit} />}
        </div>
      </div>

      <Splitter value={responseShare} min={MIN_SHARE} max={MAX_SHARE} containerRef={editorRef} onChange={setShare} />
      <section className="response-slot" aria-label="Response" style={{ flexBasis: `${responseShare * 100}%` }}>
        <ResponseViewer path={path} />
      </section>
    </div>
  )
}

const MIN_SHARE = 0.15
const MAX_SHARE = 0.8
const KEY_STEP = 0.05

interface SplitterProps {
  /** The share (0-1) of the editor height taken by the response area. */
  value: number
  min: number
  max: number
  containerRef: React.RefObject<HTMLDivElement | null>
  onChange(value: number): void
}

/** The draggable and keyboard-resizable divider between the request editor and the response. */
function Splitter({ value, min, max, containerRef, onChange }: SplitterProps): React.JSX.Element {
  const clamp = (v: number): number => Math.min(max, Math.max(min, v))

  function onPointerMove(e: React.PointerEvent): void {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.height === 0) return
    onChange(clamp((rect.bottom - e.clientY) / rect.height))
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    // The divider moves up when the response grows.
    const next =
      e.key === 'ArrowUp'
        ? value + KEY_STEP
        : e.key === 'ArrowDown'
          ? value - KEY_STEP
          : e.key === 'Home'
            ? max
            : e.key === 'End'
              ? min
              : null
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    onChange(clamp(next))
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize response"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      tabIndex={0}
      className="splitter"
      onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      onKeyDown={onKeyDown}
    />
  )
}

interface SectionTabsProps {
  idBase: string
  section: Section
  onSelect(section: Section): void
  draft: RequestItem
}

function SectionTabs({ idBase, section, onSelect, draft }: SectionTabsProps): React.JSX.Element {
  const counts: Record<Section, number> = {
    Params: draft.params.filter((p) => p.enabled).length,
    Headers: draft.headers.filter((h) => h.enabled).length,
    Body: draft.body.mode === 'none' ? 0 : 1,
    Auth: draft.auth.type === 'none' || draft.auth.type === 'inherit' ? 0 : 1,
  }

  function onKeyDown(e: React.KeyboardEvent, index: number): void {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const target = SECTIONS[(index + step + SECTIONS.length) % SECTIONS.length]!
    onSelect(target)
    document.getElementById(`${idBase}-${target}`)?.focus()
  }

  return (
    <div className="section-tabs" role="tablist" aria-label="Request sections">
      {SECTIONS.map((name, i) => (
        <button
          key={name}
          type="button"
          role="tab"
          id={`${idBase}-${name}`}
          aria-selected={section === name}
          aria-controls={`${idBase}-panel`}
          tabIndex={section === name ? 0 : -1}
          className="section-tab"
          onClick={() => onSelect(name)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {name}
          {counts[name] > 0 && <span className="section-count"> ({counts[name]})</span>}
        </button>
      ))}
    </div>
  )
}

interface PanelProps {
  draft: RequestItem
  edit(patch: Partial<RequestItem>): void
}

function BodyPanel({ draft, edit }: PanelProps): React.JSX.Element {
  const { body } = draft
  const group = useId()

  function switchTo(mode: RequestBody['mode']): void {
    if (mode === body.mode) return
    remember(draft.id, 'body', body)
    edit({ body: recall(draft.id, 'body', mode, EMPTY_BODIES[mode]) })
  }

  return (
    <div className="body-panel">
      <fieldset className="radio-row">
        <legend className="sr-only">Body type</legend>
        {BODY_MODES.map(({ mode, label }) => (
          <label key={mode} className="radio">
            <input type="radio" name={group} checked={body.mode === mode} onChange={() => switchTo(mode)} />
            {label}
          </label>
        ))}
      </fieldset>

      {body.mode === 'none' && <p className="muted">This request has no body.</p>}
      {body.mode === 'raw' && (
        <>
          <label className="field-row">
            <span>Language</span>
            <select
              className="text-input"
              value={body.language}
              onChange={(e) => edit({ body: { ...body, language: e.target.value as typeof body.language } })}
            >
              {(['json', 'text', 'xml', 'html'] as const).map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <div className="body-editor">
            <CodeEditor
              label="Body"
              language={body.language}
              value={body.content}
              onChange={(content) => edit({ body: { ...body, content } })}
            />
          </div>
        </>
      )}
      {(body.mode === 'urlencoded' || body.mode === 'formdata') && (
        <>
          {body.mode === 'formdata' && <p className="muted note">Text fields only; file uploads are not supported.</p>}
          <KeyValueTable noun="field" rows={body.fields} onChange={(fields) => edit({ body: { ...body, fields } })} />
        </>
      )}
    </div>
  )
}

function AuthPanel({ draft, edit }: PanelProps): React.JSX.Element {
  const { auth } = draft
  const patch = (change: Partial<Auth>): void => edit({ auth: { ...auth, ...change } as Auth })

  function switchTo(type: Auth['type']): void {
    if (type === auth.type) return
    remember(draft.id, 'auth', auth)
    edit({ auth: recall(draft.id, 'auth', type, EMPTY_AUTHS[type]) })
  }

  return (
    <div className="auth-panel">
      <label className="field-row">
        <span>Auth type</span>
        <select className="text-input" value={auth.type} onChange={(e) => switchTo(e.target.value as Auth['type'])}>
          {AUTH_TYPES.map(({ type, label }) => (
            <option key={type} value={type}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {auth.type === 'inherit' && (
        <p className="muted">Uses the auth of the folder or collection above this request.</p>
      )}
      {auth.type === 'none' && <p className="muted">No authorization is added.</p>}
      {auth.type === 'bearer' && <TextField label="Token" value={auth.token} onChange={(token) => patch({ token })} />}
      {auth.type === 'basic' && (
        <>
          <TextField label="Username" value={auth.username} onChange={(username) => patch({ username })} />
          <TextField
            label="Password"
            type="password"
            value={auth.password}
            onChange={(password) => patch({ password })}
          />
        </>
      )}
      {auth.type === 'apikey' && (
        <>
          <TextField label="Key" value={auth.key} onChange={(key) => patch({ key })} />
          <TextField label="Value" value={auth.value} onChange={(value) => patch({ value })} />
          <label className="field-row">
            <span>Add to</span>
            <select
              className="text-input"
              value={auth.in}
              onChange={(e) => patch({ in: e.target.value as 'header' | 'query' })}
            >
              <option value="header">Header</option>
              <option value="query">Query</option>
            </select>
          </label>
        </>
      )}
    </div>
  )
}

interface TextFieldProps {
  label: string
  value: string
  onChange(value: string): void
  type?: 'text' | 'password'
}

function TextField({ label, value, onChange, type = 'text' }: TextFieldProps): React.JSX.Element {
  return (
    <label className="field-row">
      <span>{label}</span>
      <input
        className="text-input mono"
        type={type}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
