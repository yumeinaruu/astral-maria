import { Columns2, Layers, PanelLeft, Rows2, SquareTerminal } from 'lucide-react'
import { shortcut } from '../lib/platform'
import { openActiveEnvironment } from '../lib/tabs'
import { useApp } from '../state/store'
import { useUi } from '../state/ui'
import { SyncButton } from './sync/SyncButton'

/**
 * Bottom bar: sidebar toggle, Console and workspace folder on the left; git sync, layout toggle and Environments on the
 * right.
 */
export function StatusBar(): React.JSX.Element {
  const dir = useApp((s) => s.workspace?.dir ?? '')
  const sidebarVisible = useUi((s) => s.sidebarVisible)
  const layout = useUi((s) => s.layout)
  const consoleOpen = useUi((s) => s.consoleOpen)
  const sideBySide = layout === 'side'

  return (
    <footer className="statusbar">
      <button
        type="button"
        className="icon-btn"
        aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
        title={`${sidebarVisible ? 'Hide' : 'Show'} sidebar (${shortcut('\\')})`}
        aria-pressed={sidebarVisible}
        onClick={() => useUi.getState().toggleSidebar()}
      >
        <PanelLeft size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="btn btn-text"
        aria-pressed={consoleOpen}
        onClick={() => useUi.getState().toggleConsole()}
      >
        <SquareTerminal size={13} aria-hidden="true" />
        Console
      </button>
      <span className="statusbar-path" title={dir}>
        {dir}
      </span>
      <div className="statusbar-right">
        <SyncButton />
        <button
          type="button"
          className="icon-btn"
          aria-label={sideBySide ? 'Show the response below the request' : 'Show the response beside the request'}
          title={sideBySide ? 'Stacked layout' : 'Side-by-side layout'}
          onClick={() => useUi.getState().setLayout(sideBySide ? 'stacked' : 'side')}
        >
          {sideBySide ? <Rows2 size={15} aria-hidden="true" /> : <Columns2 size={15} aria-hidden="true" />}
        </button>
        <button type="button" className="btn btn-text" onClick={openActiveEnvironment}>
          <Layers size={13} aria-hidden="true" />
          Environments
        </button>
      </div>
    </footer>
  )
}
