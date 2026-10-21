import { Search } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { shortcut } from '../lib/platform'
import { searchRequests } from '../lib/search'
import { useApp } from '../state/store'
import { MethodBadge } from './MethodBadge'

export const QUICK_OPEN_ID = 'quick-open-input'

/** The header search: type to find a request in any collection, arrows to pick, Enter to open it in a tab. */
export function QuickOpen(): React.JSX.Element {
  const collections = useApp((s) => s.collections)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const listId = useId()

  const hits = useMemo(() => searchRequests(collections, query), [collections, query])
  const shown = open && query.trim() !== ''
  const at = Math.min(highlight, Math.max(0, hits.length - 1))
  const optionId = (i: number): string => `${listId}-${i}`

  function choose(i: number): void {
    const hit = hits[i]
    if (!hit) return
    useApp.getState().openRequest(hit.path)
    setQuery('')
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      if (hits.length > 0) setHighlight((at + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown) choose(at)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (shown) setOpen(false)
      else {
        setQuery('')
        e.currentTarget.blur()
      }
    }
  }

  return (
    <div className="quick-open">
      <div className="quick-open-box">
        <Search size={14} aria-hidden="true" />
        <input
          id={QUICK_OPEN_ID}
          className="quick-open-input"
          type="text"
          role="combobox"
          aria-label="Search requests"
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown && hits.length > 0 ? optionId(at) : undefined}
          placeholder="Search requests"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlight(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {!query && (
          <kbd className="kbd" aria-hidden="true">
            {shortcut('K')}
          </kbd>
        )}
      </div>
      {shown && (
        <ul id={listId} className="quick-open-list" role="listbox" aria-label="Matching requests">
          {hits.length === 0 && (
            <li role="presentation" className="quick-open-empty">
              No requests match
            </li>
          )}
          {hits.map((hit, i) => (
            <li
              key={hit.path}
              id={optionId(i)}
              role="option"
              aria-selected={i === at}
              className="quick-open-option"
              // Keeps the focus in the input, so the click is not lost to its blur.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(i)}
            >
              <MethodBadge method={hit.method} />
              <span className="quick-open-name">{hit.name}</span>
              <span className="quick-open-path">{hit.location}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
