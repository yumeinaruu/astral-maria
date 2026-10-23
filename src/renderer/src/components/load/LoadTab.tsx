import { ChevronRight, Gauge } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { HttpMethod, LoadOptions } from '../../../../shared/types'
import { hostOf, isLocalHost, resolveTemplate } from '../../lib/loadReport'
import { confirmedLoadHosts, confirmLoadHosts } from '../../lib/prefs'
import { composeUrl } from '../../lib/url'
import { variableLookup } from '../../lib/variables'
import { loadTargetOf, maskSecrets, useApp } from '../../state/store'
import { ConfirmDialog } from '../ConfirmDialog'
import { LoadConfig } from './LoadConfig'
import { LoadResults } from './LoadResults'

/** The warning shown, once per host, before a load test of a host that is not loopback or private. */
export const LOAD_WARNING = 'Only load-test systems you own or have permission to test.'

/** A request of the target, with its URL resolved as it will be sent: masked for showing, and its host. */
export interface TargetRow {
  path: string
  name: string
  method: HttpMethod
  /** Resolved, secrets masked. */
  url: string
  host: string | null
}

/** The target requests of `path` with their URLs resolved once, as main will resolve them. */
function useTargetRows(path: string): { name: string; rows: TargetRow[] } {
  const collections = useApp((s) => s.collections)
  const drafts = useApp((s) => s.drafts)
  const environments = useApp((s) => s.environments)
  const activeEnvironmentId = useApp((s) => s.activeEnvironmentId)
  return useMemo(() => {
    const target = loadTargetOf(collections, drafts, path)
    const collection = collections.find((c) => path === c.path || path.startsWith(`${c.path}/`))
    const lookup = variableLookup(environments, activeEnvironmentId, collection)
    const rows = (target?.requests ?? []).map(({ path: p, name, method, request }): TargetRow => {
      const resolve = (text: string): string => resolveTemplate(text, lookup)
      const url = composeUrl(
        resolve(request.url),
        request.params.map((q) => ({ ...q, key: resolve(q.key), value: resolve(q.value) })),
      )
      return { path: p, name, method, url: maskSecrets(url, environments, activeEnvironmentId), host: hostOf(url) }
    })
    return { name: target?.name ?? path, rows }
  }, [collections, drafts, environments, activeEnvironmentId, path])
}

/** The Load test of a request, folder or collection: its configuration, then live and final results. */
export function LoadTab({ path }: { path: string }): React.JSX.Element {
  const state = useApp((s) => s.loads[path])
  const { name, rows } = useTargetRows(path)
  const [asking, setAsking] = useState<{ hosts: string[]; options: LoadOptions } | null>(null)

  if (!state) return <p className="muted editor-loading">Loading…</p>

  function start(options: LoadOptions): void {
    const requests = rows.map((r) => ({ name: r.name, method: r.method, url: r.url }))
    void useApp.getState().startLoad(path, options, requests)
  }

  /** Starts the test, after the one-time confirmation of any public host it targets. */
  function requestStart(options: LoadOptions): void {
    const confirmed = new Set(confirmedLoadHosts())
    const hosts = [...new Set(rows.map((r) => r.host).filter((h): h is string => h !== null))].filter(
      (h) => !isLocalHost(h) && !confirmed.has(h),
    )
    if (hosts.length > 0) setAsking({ hosts, options })
    else start(options)
  }

  return (
    <div className="runner load">
      <div className="crumb-row">
        <nav className="crumbs" aria-label="Load test location">
          <Gauge className="container-icon" size={16} aria-hidden="true" />
          <span className="crumb">
            <span className="crumb-part">Load test</span>
            <ChevronRight size={13} aria-hidden="true" />
          </span>
          <span className="runner-title">{name}</span>
        </nav>
      </div>
      {state.view === 'config' ? (
        <LoadConfig path={path} state={state} rows={rows} onStart={requestStart} />
      ) : (
        <LoadResults path={path} name={name} state={state} onRunAgain={requestStart} />
      )}
      {asking !== null && (
        <ConfirmDialog
          title={`Load test ${asking.hosts.join(', ')}?`}
          message={LOAD_WARNING}
          confirmLabel="Start"
          tone="primary"
          onConfirm={() => {
            const { hosts, options } = asking
            setAsking(null)
            confirmLoadHosts(hosts)
            start(options)
          }}
          onCancel={() => setAsking(null)}
        />
      )}
    </div>
  )
}
