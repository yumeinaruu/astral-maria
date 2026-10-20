import { useEffect } from 'react'
import { ErrorBanner } from './components/Banners'
import { EnvironmentSelector } from './components/EnvironmentSelector'
import { RequestEditor } from './components/RequestEditor'
import { RequestTabs, tabDomId } from './components/RequestTabs'
import { Sidebar } from './components/Sidebar'
import { WorkspaceGate } from './components/WorkspaceGate'
import { useApp } from './state/store'

export function App(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const activePath = useApp((s) => s.activePath)

  // Best effort: start any debounced save before the window goes away.
  useEffect(() => {
    const flush = (): void => useApp.getState().flushAllSaves()
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  if (!workspace) {
    return (
      <>
        <ErrorBanner />
        <WorkspaceGate />
      </>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="workspace-name" title={workspace.dir}>
          {workspace.name}
        </span>
        <div className="topbar-env">
          <EnvironmentSelector />
        </div>
      </header>
      <ErrorBanner />
      <div className="layout">
        <Sidebar />
        <main className="main">
          {activePath ? (
            <>
              <RequestTabs />
              <div role="tabpanel" className="request-panel" aria-labelledby={tabDomId(activePath)}>
                <RequestEditor key={activePath} path={activePath} />
              </div>
            </>
          ) : (
            <p className="muted empty-main">Open a request</p>
          )}
        </main>
      </div>
    </div>
  )
}
