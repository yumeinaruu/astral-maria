import { ChevronRight, ListChecks } from 'lucide-react'
import { containerNames, useApp } from '../../state/store'
import { RunnerConfig } from './RunnerConfig'
import { RunnerResults } from './RunnerResults'

/** The Runner of a collection or folder: its configuration, then the results of the run. */
export function RunnerTab({ path }: { path: string }): React.JSX.Element {
  const state = useApp((s) => s.runners[path])
  const name = useApp((s) => containerNames(s.collections, path)?.name ?? path)

  if (!state) return <p className="muted editor-loading">Loading…</p>

  return (
    <div className="runner">
      <div className="crumb-row">
        <nav className="crumbs" aria-label="Runner location">
          <ListChecks className="container-icon" size={16} aria-hidden="true" />
          <span className="crumb">
            <span className="crumb-part">Runner</span>
            <ChevronRight size={13} aria-hidden="true" />
          </span>
          <span className="runner-title">{name}</span>
        </nav>
      </div>
      {state.view === 'config' ? (
        <RunnerConfig path={path} name={name} state={state} />
      ) : (
        <RunnerResults path={path} name={name} state={state} />
      )}
    </div>
  )
}
