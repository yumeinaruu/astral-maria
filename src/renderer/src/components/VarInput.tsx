import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { completionAt, filterOptions, insertCompletion, optionValue } from '../lib/completion'
import { hasVariables, MASK, segmentsOf, SOURCE_LABELS, type Resolution, type VariableLookup } from '../lib/variables'

/** The variable lookup of the request being edited; without it, inputs show no highlighting. */
export const VariablesContext = createContext<VariableLookup | null>(null)

/** The variables the request can use, offered when `{{` is typed; without it, inputs offer no completion. */
export const VariableOptionsContext = createContext<Resolution[] | null>(null)

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

/** An open completion menu: the query it answers and where it is drawn. */
interface Menu {
  from: number
  prefix: string
  highlight: number
  left: number
  top?: number
  bottom?: number
}

/** About the width of the menu; it is kept inside the window. */
const MENU_WIDTH = 320
const MENU_MAX_HEIGHT = 240

/** The width `text` takes in `el`'s font, measured with a hidden span that copies the text metrics. */
function textWidth(el: HTMLInputElement, text: string): number {
  const cs = getComputedStyle(el)
  const span = document.createElement('span')
  span.style.position = 'absolute'
  span.style.visibility = 'hidden'
  span.style.whiteSpace = 'pre'
  span.style.fontFamily = cs.fontFamily
  span.style.fontSize = cs.fontSize
  span.style.fontWeight = cs.fontWeight
  span.style.letterSpacing = cs.letterSpacing
  span.style.fontFeatureSettings = cs.fontFeatureSettings
  span.textContent = text
  document.body.appendChild(span)
  const width = span.getBoundingClientRect().width
  span.remove()
  return width
}

/** Where the menu goes: under the `{{` that opened it (above, if there is no room below), inside the window. */
function menuPlace(el: HTMLInputElement, at: number): Pick<Menu, 'left' | 'top' | 'bottom'> {
  const rect = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const inset = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0)
  const x = rect.left + inset + textWidth(el, el.value.slice(0, at)) - el.scrollLeft
  const left = Math.max(4, Math.min(Math.max(rect.left, Math.min(x, rect.right)), window.innerWidth - MENU_WIDTH - 4))
  if (rect.bottom + 4 + MENU_MAX_HEIGHT > window.innerHeight && rect.top - 4 - MENU_MAX_HEIGHT > 0) {
    return { left, bottom: window.innerHeight - rect.top + 4 }
  }
  return { left, top: rect.bottom + 4 }
}

/**
 * A native text input that colours its `{{variables}}`: resolved ones in `--var`, unknown ones in `--var-missing`.
 * A mirror with the same box and font sits on top of the input (it ignores the pointer) and shows the coloured text,
 * while the input's own text is transparent. Caret, selection, IME, paste and undo stay the browser's. Hovering a
 * token shows its value and where it comes from. Typing `{{` offers the variables the request can use.
 */
export function VarInput({
  value,
  onChange,
  className = '',
  onScroll,
  onMouseMove,
  onMouseLeave,
  onKeyDown,
  onBlur,
  ...rest
}: Props) {
  const lookup = useContext(VariablesContext)
  const options = useContext(VariableOptionsContext)
  const input = useRef<HTMLInputElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  /** The text and query Escape closed the menu for; it stays closed until either changes. */
  const dismissed = useRef<string | null>(null)
  /** The caret to restore once the parent has applied an inserted completion. */
  const pendingCaret = useRef<{ text: string; caret: number } | null>(null)
  const listId = useId()
  const highlighted = lookup !== null && hasVariables(value)
  const matches = menu && options ? filterOptions(options, menu.prefix) : []
  const open = menu !== null && matches.length > 0
  const at = open ? Math.min(menu.highlight, matches.length - 1) : 0
  const optionId = (i: number): string => `${listId}-${i}`

  const sync = (): void => {
    const run = mirror.current?.firstElementChild as HTMLElement | null | undefined
    if (run && input.current) run.style.transform = `translateX(${-input.current.scrollLeft}px)`
  }
  useLayoutEffect(sync)

  useLayoutEffect(() => {
    const pending = pendingCaret.current
    const el = input.current
    if (!pending || !el || el.value !== pending.text) return
    pendingCaret.current = null
    el.setSelectionRange(pending.caret, pending.caret)
    sync()
  })

  useEffect(() => {
    if (open) document.getElementById(optionId(at))?.scrollIntoView?.({ block: 'nearest' })
  })

  /** Opens, moves or closes the menu for the caret's current place. */
  function refreshMenu(): void {
    const el = input.current
    if (!options || !el || document.activeElement !== el || el.selectionStart !== el.selectionEnd) {
      if (menu) setMenu(null)
      return
    }
    const caret = el.selectionStart ?? el.value.length
    const query = completionAt(el.value, caret)
    const key = query && `${query.from}:${el.value}`
    if (!query || key === dismissed.current) {
      if (menu) setMenu(null)
      return
    }
    dismissed.current = null
    if (menu && menu.from === query.from && menu.prefix === query.prefix) return
    setMenu({ from: query.from, prefix: query.prefix, highlight: 0, ...menuPlace(el, query.from - 2) })
  }

  function pick(option: Resolution): void {
    const el = input.current
    if (!el || !menu) return
    const caret = el.selectionStart ?? el.value.length
    const done = insertCompletion(el.value, menu.from, caret, option.name)
    pendingCaret.current = { text: done.text, caret: done.caret }
    setMenu(null)
    onChange(done.text)
  }

  function keyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (open && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setMenu({ ...menu, highlight: (at + step + matches.length) % matches.length })
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        pick(matches[at])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        dismissed.current = `${menu.from}:${e.currentTarget.value}`
        setMenu(null)
        return
      }
    }
    onKeyDown?.(e)
  }

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
        aria-autocomplete={options ? 'list' : undefined}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(at) : undefined}
        onChange={(e) => {
          onChange(e.target.value)
          setTip(null)
          refreshMenu()
        }}
        onScroll={(e) => {
          sync()
          onScroll?.(e)
        }}
        onSelect={() => {
          sync()
          refreshMenu()
        }}
        onKeyUp={sync}
        onKeyDown={keyDown}
        onBlur={(e) => {
          setMenu(null)
          onBlur?.(e)
        }}
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
      {tip && highlighted && !open && <VariableTip tip={tip} />}
      {open &&
        createPortal(
          <ul
            id={listId}
            className="var-menu"
            role="listbox"
            aria-label="Variables"
            style={{ left: menu.left, top: menu.top, bottom: menu.bottom }}
          >
            {matches.map((option, i) => (
              <li
                key={option.name}
                id={optionId(i)}
                role="option"
                aria-selected={i === at}
                className="var-option"
                // Keeps the focus in the input, so the click is not lost to its blur.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setMenu({ ...menu, highlight: i })}
                onClick={() => pick(option)}
              >
                <VariableOptionContent option={option} />
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  )
}

/** One completion option: the name, its resolved value (secrets masked) and where it comes from. */
export function VariableOptionContent({ option }: { option: Resolution }): React.JSX.Element {
  return (
    <>
      <span className="var-option-name">{option.name}</span>
      <span className="var-option-value">{optionValue(option)}</span>
      <span className="var-option-source">{SOURCE_LABELS[option.source]}</span>
    </>
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
