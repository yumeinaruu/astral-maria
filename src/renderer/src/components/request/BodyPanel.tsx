import type { RequestBody } from '../../../../shared/types'
import { prettyJson, prettyXml } from '../../lib/body'
import { CodeEditor } from '../CodeEditor'
import { Dropdown } from '../Dropdown'
import { KeyValueTable } from '../KeyValueTable'
import { recall, remember, type PanelProps } from './switching'

type RawLanguage = Extract<RequestBody, { mode: 'raw' }>['language']

const BODY_MODES: { value: RequestBody['mode']; label: string }[] = [
  { value: 'none', label: 'none' },
  { value: 'formdata', label: 'form-data' },
  { value: 'urlencoded', label: 'x-www-form-urlencoded' },
  { value: 'raw', label: 'raw' },
]

const LANGUAGES: { value: RawLanguage; label: string }[] = [
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'xml', label: 'XML' },
  { value: 'html', label: 'HTML' },
]

const EMPTY_BODIES: { [M in RequestBody['mode']]: Extract<RequestBody, { mode: M }> } = {
  none: { mode: 'none' },
  raw: { mode: 'raw', language: 'text', content: '' },
  urlencoded: { mode: 'urlencoded', fields: [] },
  formdata: { mode: 'formdata', fields: [] },
}

export function BodyPanel({ draft, edit }: PanelProps): React.JSX.Element {
  const { body } = draft

  function switchTo(mode: RequestBody['mode']): void {
    if (mode === body.mode) return
    remember(draft.id, 'body', body)
    edit({ body: recall(draft.id, 'body', mode, EMPTY_BODIES[mode]) })
  }

  function beautify(): void {
    if (body.mode !== 'raw') return
    const content = body.language === 'json' ? prettyJson(body.content) : prettyXml(body.content)
    if (content !== body.content) edit({ body: { ...body, content } })
  }

  return (
    <div className="body-panel">
      <div className="body-bar">
        <Dropdown label="Body type" value={body.mode} options={BODY_MODES} onChange={switchTo} />
        {body.mode === 'raw' && (
          <>
            <Dropdown
              label="Language"
              className="accent-dropdown"
              value={body.language}
              options={LANGUAGES}
              onChange={(language) => edit({ body: { ...body, language } })}
            />
            <span className="toolbar-spacer" />
            {(body.language === 'json' || body.language === 'xml') && (
              <button type="button" className="btn-text accent-text" onClick={beautify}>
                Beautify
              </button>
            )}
          </>
        )}
      </div>

      {body.mode === 'none' && <p className="body-none">This request does not have a body</p>}
      {body.mode === 'raw' && (
        <div className="body-editor">
          <CodeEditor
            label="Body"
            language={body.language}
            value={body.content}
            variables
            onChange={(content) => edit({ body: { ...body, content } })}
          />
        </div>
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
