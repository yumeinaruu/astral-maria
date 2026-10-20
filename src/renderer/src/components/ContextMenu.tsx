import { Check } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onSelect(): void
  /** Makes the item a radio choice (`menuitemradio`), checked or not. */
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  /** Extra class of the item, e.g. a method colour. */
  className?: string
  /** A small dot after the label, e.g. for a configured request section. */
  marker?: boolean
}

/** An item, or a non-interactive heading, muted note or separator. */
export type MenuEntry =
  | MenuItem
  | { heading: string }
  /** `wrap` lets a longer note run over several lines instead of being cut off. */
  | { note: string; title?: string; wrap?: boolean }
  | { separator: true }

interface Props {
  x: number
  y: number
  /** `end`: `x` is where the menu's right edge goes (for menus opened from the right side of the window). */
  align?: 'start' | 'end'
  label: string
  items: MenuEntry[]
  onClose(): void
  /** Presses on this element do not count as outside (the button that toggles the menu handles them). */
  anchor?: HTMLElement | null
}

const ITEM = '[role^="menuitem"]:not(:disabled)'
const MARGIN = 8

function isItem(entry: MenuEntry): entry is MenuItem {
  return 'label' in entry
}

export function ContextMenu({ x, y, align = 'start', label, items, onClose, anchor }: Props): React.JSX.Element {
  const ref = useRef<HTMLUListElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)

  // Kept inside the window: flipped left of `x` or above `y` when there is no room.
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    let left = align === 'end' ? x - width : x
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN))
    let top = y
    if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, window.innerHeight - height - MARGIN)
    setPlace({ left, top })
  }, [x, y, align])

  useEffect(() => {
    const menu = ref.current
    const start =
      menu?.querySelector<HTMLElement>(`${ITEM}[aria-checked="true"]`) ?? menu?.querySelector<HTMLElement>(ITEM)
    start?.focus()
    const onOutside = (e: MouseEvent): void => {
      const target = e.target as Node
      if (ref.current?.contains(target) || anchor?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [onClose, anchor])

  function onKeyDown(e: React.KeyboardEvent): void {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    const go = (i: number): void => {
      e.preventDefault()
      buttons[(i + buttons.length) % buttons.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(buttons.length - 1)
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      onClose()
    }
    e.stopPropagation()
  }

  return (
    <ul
      ref={ref}
      className="menu"
      role="menu"
      aria-label={label}
      style={place ?? { left: x, top: y, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((entry, i) => {
        if ('separator' in entry) return <li key={`sep-${i}`} role="separator" className="menu-separator" />
        if ('heading' in entry) {
          return (
            <li key={`h-${entry.heading}`} role="presentation" className="menu-heading">
              {entry.heading}
            </li>
          )
        }
        if ('note' in entry) {
          return (
            <li
              key={`n-${i}`}
              role="presentation"
              className={`menu-note${entry.wrap ? ' menu-note-wrap' : ''}`}
              title={entry.title}
            >
              {entry.note}
            </li>
          )
        }
        const radio = isItem(entry) && entry.checked !== undefined
        return (
          <li key={entry.label} role="none">
            <button
              type="button"
              role={radio ? 'menuitemradio' : 'menuitem'}
              aria-checked={radio ? entry.checked : undefined}
              className={`menu-item${entry.danger ? ' menu-item-danger' : ''}${entry.className ? ` ${entry.className}` : ''}`}
              disabled={entry.disabled}
              tabIndex={-1}
              onClick={() => {
                onClose()
                entry.onSelect()
              }}
            >
              {radio && (
                <span className="menu-check" aria-hidden="true">
                  {entry.checked && <Check size={14} strokeWidth={2.25} />}
                </span>
              )}
              <span className="menu-label">{entry.label}</span>
              {entry.marker && <span className="config-dot" aria-hidden="true" />}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
