import type { MenuItemConstructorOptions } from 'electron'

/** The window background before the renderer paints: the `--bg` token of the OS colour scheme. */
export function windowBackground(dark: boolean): string {
  return dark ? '#282924' : '#ffffff'
}

/**
 * The application menu. It keeps the standard edit commands (copy and paste need them on macOS) and quitting, but has
 * no Close Window item: Cmd/Ctrl+W is the renderer's "close tab" shortcut. The window still closes through its close
 * button, and quitting still goes through the flush in `before-quit`.
 */
export function appMenuTemplate(
  platform: NodeJS.Platform,
  appName: string,
  options: { devTools?: boolean } = {},
): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin'
  const menus: MenuItemConstructorOptions[] = []
  if (mac) {
    menus.push({
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  } else {
    menus.push({ label: 'File', submenu: [{ role: 'quit' }] })
  }
  menus.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  })
  menus.push({
    label: 'View',
    submenu: [
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(options.devTools ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : []),
    ],
  })
  menus.push({
    label: 'Window',
    submenu: mac ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] : [{ role: 'minimize' }],
  })
  return menus
}
