import { useEffect, useRef } from 'react'

export interface MenuItem {
  label: string
  onSelect(): void
}

interface Props {
  x: number
  y: number
  label: string
  items: MenuItem[]
  onClose(): void
}

export function ContextMenu({ x, y, label, items, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLUListElement>(null)

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onOutside = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [onClose])

  function onKeyDown(e: React.KeyboardEvent): void {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
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
      style={{ left: x, top: y }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <li key={item.label} role="none">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  )
}
