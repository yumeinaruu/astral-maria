import { useState } from 'react'
import type { HttpMethod, RequestItem } from '../../../../shared/types'
import { shortcut } from '../../lib/platform'
import { composeUrl, splitUrl } from '../../lib/url'
import { useApp } from '../../state/store'
import { Dropdown } from '../Dropdown'
import { VarInput } from '../VarInput'

export const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

const METHOD_OPTIONS = METHODS.map((m) => ({ value: m, label: m, className: `method-${m.toLowerCase()}` }))

interface Props {
  path: string
  draft: RequestItem
  edit(patch: Partial<RequestItem>): void
}

/** One box with the method and the URL, then Send (Cancel while sending). */
export function UrlBar({ path, draft, edit }: Props): React.JSX.Element {
  const sending = useApp((s) => s.responses[path]?.state === 'sending')
  const [typedUrl, setTypedUrl] = useState<string | null>(null)
  const store = useApp.getState

  const composed = composeUrl(draft.url, draft.params)
  // While the user types, keep their text as long as the draft still corresponds to it (it differs once the params change).
  const split = typedUrl === null ? null : splitUrl(typedUrl, draft.params)
  const urlText = typedUrl !== null && split && composeUrl(split.url, split.params) === composed ? typedUrl : composed

  return (
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
    </div>
  )
}
