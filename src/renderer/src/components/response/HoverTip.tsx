import { useId, useState } from 'react'

interface Props {
  tip: React.ReactNode
  children: React.ReactNode
  className?: string
}

/** Text that shows a small tooltip below itself on hover or keyboard focus. */
export function HoverTip({ tip, children, className = '' }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span
      className={`hover-tip ${className}`}
      tabIndex={0}
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span id={id} role="tooltip" className="hover-tip-box">
          {tip}
        </span>
      )}
    </span>
  )
}
