import { useId, useState } from 'react'
import type { Scripts } from '../../../../shared/types'
import { CodeEditor } from '../CodeEditor'

type ScriptKey = keyof Scripts

const KINDS: { key: ScriptKey; label: string; hint: string }[] = [
  { key: 'preRequest', label: 'Pre-request', hint: 'Runs before the request is sent.' },
  { key: 'postResponse', label: 'Post-response', hint: 'Runs after the response arrives. Write tests here.' },
]

const EMPTY: Scripts = { preRequest: '', postResponse: '' }

/** A script runs only when it has more than whitespace (see `main/scripts/pipeline.ts`). */
function hasText(script: string | undefined): boolean {
  return (script ?? '').trim() !== ''
}

/** Whether any script would run; marks the section. */
export function hasScripts(scripts: Scripts | undefined): boolean {
  return hasText(scripts?.preRequest) || hasText(scripts?.postResponse)
}

interface Props {
  scripts: Scripts | undefined
  /** `undefined` when both scripts are empty, so the field is dropped from the file. */
  onChange(scripts: Scripts | undefined): void
}

/** The pre-request and post-response scripts of a request (or a collection or folder): a vertical list and an editor. */
export function ScriptsPanel({ scripts, onChange }: Props): React.JSX.Element {
  const [selected, setSelected] = useState<ScriptKey>('preRequest')
  const idBase = useId()
  const current = scripts ?? EMPTY
  const kind = KINDS.find((k) => k.key === selected)!

  function edit(value: string): void {
    const next = { ...current, [selected]: value }
    onChange(next.preRequest === '' && next.postResponse === '' ? undefined : next)
  }

  function onKeyDown(e: React.KeyboardEvent, index: number): void {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const target = KINDS[(index + step + KINDS.length) % KINDS.length]!.key
    setSelected(target)
    document.getElementById(`${idBase}-${target}`)?.focus()
  }

  return (
    <div className="scripts-panel">
      <div className="scripts-list" role="tablist" aria-label="Scripts" aria-orientation="vertical">
        {KINDS.map((k, i) => (
          <button
            key={k.key}
            type="button"
            role="tab"
            id={`${idBase}-${k.key}`}
            aria-selected={selected === k.key}
            aria-controls={`${idBase}-panel`}
            tabIndex={selected === k.key ? 0 : -1}
            className="scripts-item"
            onClick={() => setSelected(k.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {k.label}
            {hasText(current[k.key]) && (
              <>
                <span className="config-dot" aria-hidden="true" />
                <span className="sr-only"> (has a script)</span>
              </>
            )}
          </button>
        ))}
      </div>
      <div className="scripts-editor" role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-${selected}`}>
        <p className="scripts-hint">{kind.hint}</p>
        <div className="body-editor">
          <CodeEditor
            key={selected}
            label={`${kind.label} script`}
            language="javascript"
            value={current[selected]}
            onChange={edit}
          />
        </div>
      </div>
    </div>
  )
}
