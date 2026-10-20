import type { LoadError } from '../../../shared/types'
import { useApp } from '../state/store'

/** Shows the last failed action; the store already refreshed the tree by the time this is visible. */
export function ErrorBanner(): React.JSX.Element | null {
  const error = useApp((s) => s.error)
  const dismiss = useApp((s) => s.dismissError)
  if (!error) return null
  return (
    <div className="banner banner-error" role="alert">
      <span className="banner-text">{error}</span>
      <button type="button" className="btn btn-ghost" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  )
}

export function LoadErrorsBanner({ errors }: { errors: LoadError[] }): React.JSX.Element | null {
  if (errors.length === 0) return null
  return (
    <section className="banner banner-warn" aria-label="Files that could not be loaded">
      <strong>
        {errors.length} {errors.length === 1 ? 'file' : 'files'} could not be loaded
      </strong>
      <ul className="load-errors">
        {errors.map((e) => (
          <li key={e.path}>
            <code className="mono">{e.path}</code>
            <span className="muted"> {e.message}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
