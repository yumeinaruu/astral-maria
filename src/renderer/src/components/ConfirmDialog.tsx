import { useEffect, useId, useRef } from 'react'

interface Props {
  title: string
  message: string
  confirmLabel: string
  /** The confirm button's style: `danger` (the default) for destructive actions, `primary` otherwise. */
  tone?: 'danger' | 'primary'
  onConfirm(): void
  onCancel(): void
}

/** In-app replacement for window.confirm: focus starts on Cancel, Escape cancels, Tab stays inside, focus is restored. */
export function ConfirmDialog({ title, message, confirmLabel, tone = 'danger', onConfirm, onCancel }: Props): React.JSX.Element {
  const titleId = useId()
  const messageId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => previous?.focus()
  }, [])

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'Tab') {
      const first = e.shiftKey ? confirmRef.current : cancelRef.current
      const last = e.shiftKey ? cancelRef.current : confirmRef.current
      if (document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        <p id={messageId}>{message}</p>
        <div className="dialog-actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={`btn btn-${tone}`} ref={confirmRef} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
