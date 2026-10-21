import { useEffect, useRef } from 'react'

interface Props {
  initial?: string
  onCommit(name: string): void
  onCancel(): void
  /** Blur commits instead of cancelling (the rename of a just-created item). */
  commitOnBlur?: boolean
}

/** Inline text input for creating and renaming tree items: Enter commits, Escape cancels, blur cancels (or commits). */
export function NameInput({ initial = '', onCommit, onCancel, commitOnBlur = false }: Props): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  /** Set once Enter, Escape or blur has decided; the blur that follows unmounting must not decide again. */
  const done = useRef(false)
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
      onBlur={(e) => {
        if (done.current) return
        done.current = true
        const name = e.currentTarget.value.trim()
        if (commitOnBlur && name) onCommit(name)
        else onCancel()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          done.current = true
          onCancel()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          done.current = true
          const name = e.currentTarget.value.trim()
          if (name) onCommit(name)
          else onCancel()
        }
      }}
    />
  )
}
