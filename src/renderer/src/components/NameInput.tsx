import { useEffect, useRef } from 'react'

interface Props {
  initial?: string
  onCommit(name: string): void
  onCancel(): void
}

/** Inline text input for creating and renaming tree items: Enter commits, Escape or blur cancels. */
export function NameInput({ initial = '', onCommit, onCancel }: Props): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  return (
    <input
      ref={ref}
      className="name-input"
      type="text"
      aria-label="Name"
      defaultValue={initial}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onBlur={onCancel}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          const name = e.currentTarget.value.trim()
          if (name) onCommit(name)
          else onCancel()
        }
      }}
    />
  )
}
