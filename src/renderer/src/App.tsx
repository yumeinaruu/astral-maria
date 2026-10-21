import { Plus, Search } from 'lucide-react'
import { useEffect } from 'react'
import { ErrorBanner } from './components/Banners'
import { EnvironmentEditor } from './components/EnvironmentEditor'
import { Header } from './components/Header'
import { ImportDialog } from './components/ImportDialog'
import { QUICK_OPEN_ID } from './components/QuickOpen'
import { RequestEditor } from './components/RequestEditor'
import { RequestTabs, tabDomId } from './components/RequestTabs'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { WorkspaceGate } from './components/WorkspaceGate'
import { hasMod, shortcut } from './lib/platform'
import { createRequestHere } from './lib/tabs'
import { environmentIdOf, useApp } from './state/store'
import { useUi } from './state/ui'

export function App(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const activePath = useApp((s) => s.activePath)
  const sidebarVisible = useUi((s) => s.sidebarVisible)
  const importOpen = useUi((s) => s.importOpen)

  // The Import dialog belongs to a workspace; it does not reappear in the next one.
  useEffect(() => {
    if (!workspace) useUi.getState().setImportOpen(false)
  }, [workspace])

  // Best effort: start any debounced save before the window goes away.
  useEffect(() => {
    const flush = (): void => useApp.getState().flushAllSaves()
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  // Before quitting or closing the window, main asks for every unsaved draft to be written and waits for the answer.
  useEffect(
    () =>
      window.astralEvents?.onFlushRequest(() => {
        void useApp
          .getState()
          .flushAll()
          .catch(() => undefined)
          .then(() => window.astral.app.flushed())
          .catch(() => undefined)
      }),
    [],
  )

  // App-wide shortcuts; the tab strip handles the tab ones.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!useApp.getState().workspace || !hasMod(e) || e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const input = document.getElementById(QUICK_OPEN_ID) as HTMLInputElement | null
        input?.focus()
        input?.select()
      } else if (e.key.toLowerCase() === 'o') {
        e.preventDefault()
        useUi.getState().setImportOpen(true)
      } else if (e.key === '\\') {
        e.preventDefault()
        useUi.getState().toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!workspace) {
    return (
      <>
        <ErrorBanner />
        <WorkspaceGate />
      </>
    )
  }

  const envId = activePath === null ? null : environmentIdOf(activePath)

  return (
    <div className="app">
      <Header />
      <ErrorBanner />
      <div className="layout">
        {sidebarVisible && <Sidebar />}
        <main className="main">
          <RequestTabs />
          {activePath === null ? (
            <EmptyMain />
          ) : (
            <div role="tabpanel" className="tab-panel" aria-labelledby={tabDomId(activePath)}>
              {envId !== null ? (
                <EnvironmentEditor key={activePath} envId={envId} />
              ) : (
                <RequestEditor key={activePath} path={activePath} />
              )}
            </div>
          )}
        </main>
      </div>
      <StatusBar />
      {importOpen && <ImportDialog onClose={() => useUi.getState().setImportOpen(false)} />}
    </div>
  )
}

function EmptyMain(): React.JSX.Element {
  const hasCollections = useApp((s) => s.collections.length > 0)
  return (
    <div className="empty-main">
      <Search size={28} strokeWidth={1.5} aria-hidden="true" />
      <p>Open a request from the sidebar or press {shortcut('K')} to search</p>
      <button type="button" className="btn" disabled={!hasCollections} onClick={() => void createRequestHere()}>
        <Plus size={14} aria-hidden="true" />
        New request
      </button>
    </div>
  )
}
