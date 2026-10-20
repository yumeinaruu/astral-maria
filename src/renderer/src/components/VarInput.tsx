import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react'
import { hasVariables, MASK, segmentsOf, SOURCE_LABELS, type Resolution, type VariableLookup } from '../lib/variables'

/** The variable lookup of the request being edited; without it, inputs show no highlighting. */
export const VariablesContext = createContext<VariableLookup | null>(null)

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>

interface Props extends InputProps {
  value: string
  onChange(value: string): void
}

interface Tip {
  name: string
  resolution: Resolution | null
  left: number
  top: number
}

/**
 * A native text input that colours its `{{variables}}`: resolved ones in `--var`, unknown ones in `--var-missing`.
 * A mirror with the same box and font sits on top of the input (it ignores the pointer) and shows the coloured text,
 * while the input's own text is transparent. Caret, selection, IME, paste and undo stay the browser's. Hovering a
 * token shows its value and where it comes from.
 */
export function VarInput({ value, onChange, className = '', onScroll, onMouseMove, onMouseLeave, ...rest }: Props) {
  const lookup = useContext(VariablesContext)
  const input = useRef<HTMLInputElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  const highlighted = lookup !== null && hasVariables(value)

  const sync = (): void => {
    const run = mirror.current?.firstElementChild as HTMLElement | null | undefined
    if (run && input.current) run.style.transform = `translateX(${-input.current.scrollLeft}px)`
  }
  useLayoutEffect(sync)

  function hover(e: React.MouseEvent<HTMLInputElement>): void {
    if (!highlighted || !lookup) return
    const tokens = mirror.current?.querySelectorAll<HTMLElement>('[data-var]') ?? []
    for (const token of tokens) {
      const r = token.getBoundingClientRect()
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        const name = token.dataset.var ?? ''
        if (tip?.name !== name || tip.left !== r.left) {
          setTip({ name, resolution: name ? lookup(name) : null, left: r.left, top: r.bottom + 4 })
        }
        return
      }
    }
    if (tip) setTip(null)
  }

  return (
    <div className={`var-input${highlighted ? ' var-input-on' : ''}`}>
      <input
        ref={input}
        {...rest}
        type="text"
        className={className}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value)
          setTip(null)
        }}
        onScroll={(e) => {
          sync()
          onScroll?.(e)
        }}
        onSelect={sync}
        onKeyUp={sync}
        onMouseMove={(e) => {
          hover(e)
          onMouseMove?.(e)
        }}
        onMouseLeave={(e) => {
          setTip(null)
          onMouseLeave?.(e)
        }}
      />
      {highlighted && (
        <div ref={mirror} className={`${className} var-mirror`} aria-hidden="true">
          <span className="var-run">
            <Highlighted text={value} lookup={lookup} />
          </span>
        </div>
      )}
      {tip && highlighted && <VariableTip tip={tip} />}
    </div>
  )
}

/** `text` with its `{{variables}}` coloured; also used for read-only values. */
export function Highlighted({ text, lookup }: { text: string; lookup: VariableLookup | null }): React.JSX.Element {
  return (
    <>
      {segmentsOf(text).map((s, i) =>
        s.variable === undefined ? (
          s.text
        ) : (
          <span
            key={i}
            data-var={s.variable}
            className={`var-token ${s.variable && lookup?.(s.variable) ? 'var-resolved' : 'var-missing'}`}
          >
            {s.text}
          </span>
        ),
      )}
    </>
  )
}

/** Read-only text with highlighted variables. */
export function VarText({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const lookup = useContext(VariablesContext)
  return (
    <span className={className}>
      <Highlighted text={text} lookup={lookup} />
    </span>
  )
}

function VariableTip({ tip }: { tip: Tip }): React.JSX.Element {
  const r = tip.resolution
  return (
    <div className="var-tip" role="tooltip" style={{ left: tip.left, top: tip.top }}>
      <div className="var-tip-name mono">{tip.name || 'Invalid variable name'}</div>
      {r ? (
        <>
          <div className="var-tip-value mono">{r.secret ? MASK : r.value === '' ? <em>empty</em> : r.value}</div>
          <div className="var-tip-source">
            {SOURCE_LABELS[r.source]}
            {r.source !== 'globals' && ` · ${r.scopeName}`}
          </div>
        </>
      ) : (
        <div className="var-tip-missing">Unresolved</div>
      )}
    </div>
  )
}
