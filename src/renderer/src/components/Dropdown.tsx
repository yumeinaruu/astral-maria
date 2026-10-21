import { ChevronDown } from 'lucide-react'
import { MenuButton } from './MenuButton'

export interface DropdownOption<T extends string> {
  value: T
  label: string
  /** Class of the menu item, e.g. a method colour. */
  className?: string
  marker?: boolean
}

interface Props<T extends string> {
  /** Accessible name of the button and its menu. */
  label: string
  value: T
  options: DropdownOption<T>[]
  onChange(value: T): void
  className?: string
  /** Shown before the value. */
  icon?: React.ReactNode
  /** Replaces the label of the current option. */
  display?: React.ReactNode
  align?: 'start' | 'end'
  disabled?: boolean
}

/** A button showing the current choice; it opens a menu of radio items. Replaces native selects. */
export function Dropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  className = 'raised-btn',
  icon,
  display,
  align,
  disabled,
}: Props<T>): React.JSX.Element {
  const current = options.find((o) => o.value === value)
  return (
    <MenuButton
      label={label}
      className={`dropdown ${className}`}
      align={align}
      disabled={disabled}
      items={() =>
        options.map((o) => ({
          label: o.label,
          checked: o.value === value,
          className: o.className,
          marker: o.marker,
          onSelect: () => {
            if (o.value !== value) onChange(o.value)
          },
        }))
      }
    >
      {icon}
      <span className="dropdown-value">{display ?? current?.label ?? value}</span>
      <ChevronDown className="dropdown-chevron" size={14} aria-hidden="true" />
    </MenuButton>
  )
}
