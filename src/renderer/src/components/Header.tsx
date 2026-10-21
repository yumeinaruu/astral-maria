import { ChevronDown, Layers, Settings } from 'lucide-react'
import { THEMES } from '../lib/theme'
import { useApp } from '../state/store'
import { useUi } from '../state/ui'
import { MenuButton } from './MenuButton'
import { QuickOpen } from './QuickOpen'
import { useSwitchWorkspace } from './SwitchWorkspace'

/** Top bar: the workspace menu, the request search and the settings menu. */
export function Header(): React.JSX.Element | null {
  const workspace = useApp((s) => s.workspace)
  const theme = useUi((s) => s.theme)
  const switcher = useSwitchWorkspace()
  if (!workspace) return null

  return (
    <header className="header">
      <div className="header-left">
        <MenuButton
          label={`Workspace ${workspace.name}`}
          menuLabel="Workspace"
          title={workspace.dir}
          className="workspace-btn"
          items={[
            { note: workspace.dir, title: workspace.dir },
            { separator: true },
            { label: 'Switch workspace…', disabled: switcher.busy, onSelect: switcher.start },
          ]}
        >
          <Layers size={15} aria-hidden="true" />
          <span className="workspace-name">{workspace.name}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </MenuButton>
      </div>
      <QuickOpen />
      <div className="header-right">
        <MenuButton
          label="Settings"
          align="end"
          items={[
            { heading: 'Theme' },
            ...THEMES.map((t) => ({
              label: t.label,
              checked: theme === t.value,
              onSelect: () => useUi.getState().setTheme(t.value),
            })),
          ]}
        >
          <Settings size={16} aria-hidden="true" />
        </MenuButton>
      </div>
      {switcher.dialog}
    </header>
  )
}
