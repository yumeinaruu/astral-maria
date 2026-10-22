import { create } from 'zustand'
import { isBoolean, isNumber, oneOf, readPref, writePref } from '../lib/prefs'
import { loadTheme, saveTheme, type ThemePreference } from '../lib/theme'

/** Where the response sits relative to the request. */
export type PaneLayout = 'side' | 'stacked'
export type SidebarSection = 'collections' | 'environments'

export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 520
export const SIDEBAR_DEFAULT = 300

/** The share (0-1) of the request area the response takes, per layout. */
export const SHARE_MIN = 0.2
export const SHARE_MAX = 0.8
export const SHARE_DEFAULTS: Record<PaneLayout, number> = { side: 0.5, stacked: 0.45 }

export function clampShare(share: number): number {
  return Math.min(SHARE_MAX, Math.max(SHARE_MIN, share))
}

const isShares = (v: unknown): v is Record<PaneLayout, number> =>
  typeof v === 'object' &&
  v !== null &&
  isNumber((v as Record<string, unknown>).side) &&
  isNumber((v as Record<string, unknown>).stacked)

/** Height of the bottom console panel in px. */
export const CONSOLE_MIN = 120
export const CONSOLE_MAX = 600
export const CONSOLE_DEFAULT = 200

export function clampConsole(height: number): number {
  return Math.round(Math.min(CONSOLE_MAX, Math.max(CONSOLE_MIN, height)))
}

export function clampSidebar(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)))
}

/** Layout preferences of this machine; separate from the workspace store, persisted in localStorage. */
export interface UiState {
  theme: ThemePreference
  sidebarVisible: boolean
  sidebarWidth: number
  sections: Record<SidebarSection, boolean>
  layout: PaneLayout
  /** How much of the request area the response takes, per layout. */
  responseShare: Record<PaneLayout, number>
  /** Long lines of the response body wrap. */
  responseWrap: boolean
  /** The console panel is shown; not persisted. */
  consoleOpen: boolean
  consoleHeight: number
  /** The environment whose sidebar row is in inline rename (just created or duplicated); not persisted. */
  renamingEnvironment: string | null
  /** The Import dialog is open; not persisted. */
  importOpen: boolean
  setTheme(theme: ThemePreference): void
  toggleSidebar(): void
  setSidebarWidth(width: number): void
  setSectionOpen(section: SidebarSection, open: boolean): void
  setLayout(layout: PaneLayout): void
  setResponseShare(layout: PaneLayout, share: number): void
  setResponseWrap(wrap: boolean): void
  setRenamingEnvironment(id: string | null): void
  setImportOpen(open: boolean): void
  toggleConsole(): void
  setConsoleHeight(height: number): void
}

const isSections = (v: unknown): v is Record<SidebarSection, boolean> =>
  typeof v === 'object' &&
  v !== null &&
  isBoolean((v as Record<string, unknown>).collections) &&
  isBoolean((v as Record<string, unknown>).environments)

export function loadUi(): Omit<
  UiState,
  `set${string}` | `toggle${string}` | 'renamingEnvironment' | 'importOpen' | 'consoleOpen'
> {
  const shares = readPref('responseShare', SHARE_DEFAULTS, isShares)
  return {
    theme: loadTheme(),
    sidebarVisible: readPref('sidebarVisible', true, isBoolean),
    sidebarWidth: clampSidebar(readPref('sidebarWidth', SIDEBAR_DEFAULT, isNumber)),
    sections: readPref('sections', { collections: true, environments: true }, isSections),
    layout: readPref('layout', 'side', oneOf<PaneLayout>('side', 'stacked')),
    responseShare: { side: clampShare(shares.side), stacked: clampShare(shares.stacked) },
    responseWrap: readPref('responseWrap', true, isBoolean),
    consoleHeight: clampConsole(readPref('consoleHeight', CONSOLE_DEFAULT, isNumber)),
  }
}

export const useUi = create<UiState>()((set, get) => ({
  ...loadUi(),
  renamingEnvironment: null,
  importOpen: false,
  consoleOpen: false,
  setTheme(theme) {
    saveTheme(theme)
    set({ theme })
  },
  toggleSidebar() {
    const sidebarVisible = !get().sidebarVisible
    writePref('sidebarVisible', sidebarVisible)
    set({ sidebarVisible })
  },
  setSidebarWidth(width) {
    const sidebarWidth = clampSidebar(width)
    writePref('sidebarWidth', sidebarWidth)
    set({ sidebarWidth })
  },
  setSectionOpen(section, open) {
    const sections = { ...get().sections, [section]: open }
    writePref('sections', sections)
    set({ sections })
  },
  setLayout(layout) {
    writePref('layout', layout)
    set({ layout })
  },
  setResponseShare(layout, share) {
    const responseShare = { ...get().responseShare, [layout]: clampShare(share) }
    writePref('responseShare', responseShare)
    set({ responseShare })
  },
  setResponseWrap(responseWrap) {
    writePref('responseWrap', responseWrap)
    set({ responseWrap })
  },
  setRenamingEnvironment: (renamingEnvironment) => set({ renamingEnvironment }),
  setImportOpen: (importOpen) => set({ importOpen }),
  toggleConsole: () => set({ consoleOpen: !get().consoleOpen }),
  setConsoleHeight(height) {
    const consoleHeight = clampConsole(height)
    writePref('consoleHeight', consoleHeight)
    set({ consoleHeight })
  },
}))
