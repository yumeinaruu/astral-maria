import { useEffect, useId, useRef } from 'react'

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

interface Props {
  title: string
  className?: string
  busy?: boolean
  onClose(): void
  /** Submitting the form (Enter in a field, or the submit button). */
  onSubmit?(): void
  children: React.ReactNode
}

/**
 * The frame of the sync dialogs: a modal form. Focus starts on the first field (or button), Escape closes, Tab stays
 * inside and focus is restored on close, as in `ConfirmDialog`.
 */
export function SyncDialog({ title, className, busy, onClose, onSubmit, children }: Props): React.JSX.Element {
  const titleId = useId()
  const ref = useRef<HTMLFormElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first =
      ref.current?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)') ??
      ref.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => previous?.focus()
  }, [])

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Tab') {
      const focusable = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const edge = e.shiftKey ? first : last
      if (document.activeElement === edge || !ref.current?.contains(document.activeElement)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <form
        ref={ref}
        className={`dialog sync-dialog${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy) onSubmit?.()
        }}
      >
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        {children}
      </form>
    </div>
  )
}

/** An error shown inside a dialog. */
export function DialogError({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null
  return (
    <p className="sync-error" role="alert">
      {message}
    </p>
  )
}

export interface Identity {
  name: string
  email: string
}

/** Name and Email for a repository without a git identity; saved with `git config --local`. */
export function IdentityFields({
  value,
  onChange,
  disabled,
}: {
  value: Identity
  onChange(value: Identity): void
  disabled?: boolean
}): React.JSX.Element {
  const nameId = useId()
  const emailId = useId()
  return (
    <fieldset className="sync-identity" disabled={disabled}>
      <legend className="sync-label">Who is committing</legend>
      <p className="sync-hint">Git needs a name and email for commits. They are saved for this repository only.</p>
      <div className="sync-identity-fields">
        <div className="sync-field">
          <label htmlFor={nameId} className="sync-label">
            Name
          </label>
          <input
            id={nameId}
            className="text-input"
            autoComplete="name"
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </div>
        <div className="sync-field">
          <label htmlFor={emailId} className="sync-label">
            Email
          </label>
          <input
            id={emailId}
            className="text-input"
            type="email"
            autoComplete="email"
            value={value.email}
            onChange={(e) => onChange({ ...value, email: e.target.value })}
          />
        </div>
      </div>
    </fieldset>
  )
}

export function identityComplete(value: Identity): boolean {
  return value.name.trim() !== '' && value.email.trim() !== ''
}
