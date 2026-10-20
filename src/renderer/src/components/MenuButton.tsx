import { useCallback, useRef, useState } from 'react'
import { ContextMenu, type MenuEntry } from './ContextMenu'

interface Props {
  /** Accessible name of the button; `children` is what it shows. */
  label: string
  /** Accessible name of the menu; defaults to `label`. */
  menuLabel?: string
  title?: string
  className?: string
  disabled?: boolean
  /** `end` lines the menu up with the button's right edge. */
  align?: 'start' | 'end'
  items: MenuEntry[] | (() => MenuEntry[])
  children: React.ReactNode
}

/** A button that opens a menu below itself; focus returns to the button when the menu closes. */
export function MenuButton({
  label,
  menuLabel,
  title,
  className = 'icon-btn',
  disabled,
  align = 'start',
  items,
  children,
}: Props): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)

  const close = useCallback(() => {
    setAt(null)
    ref.current?.focus()
  }, [])

  function open(): void {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    setAt({ x: align === 'end' ? rect.right : rect.left, y: rect.bottom + 4 })
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        aria-label={label}
        title={title ?? label}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        disabled={disabled}
        onClick={() => (at ? close() : open())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !at) {
            e.preventDefault()
            open()
          }
        }}
      >
        {children}
      </button>
      {at && (
        <ContextMenu
          x={at.x}
          y={at.y}
          align={align}
          label={menuLabel ?? label}
          items={typeof items === 'function' ? items() : items}
          anchor={ref.current}
          onClose={close}
        />
      )}
    </>
  )
}
