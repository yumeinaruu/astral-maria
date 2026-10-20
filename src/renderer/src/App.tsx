import { ErrorBanner } from './components/Banners'
import { Sidebar } from './components/Sidebar'
import { WorkspaceGate } from './components/WorkspaceGate'
import { useApp } from './state/store'

export function App(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const activePath = useApp((s) => s.activePath)

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
        {/* Reserved for the environment selector (Task 12). */}
        <div className="topbar-env" id="environment-slot" />
      </header>
      <ErrorBanner />
      <div className="layout">
        <Sidebar />
        <main className="main">
          {/* Task 10 replaces this placeholder with the request tabs and editor. */}
          {activePath ? <p className="mono muted">{activePath}</p> : <p className="muted">Open a request</p>}
        </main>
      </div>
    </div>
  )
}
