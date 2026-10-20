import { create } from 'zustand'
import { isBoolean, isNumber, oneOf, readPref, writePref } from '../lib/prefs'
import { loadTheme, saveTheme, type ThemePreference } from '../lib/theme'

/** Where the response sits relative to the request. */
export type PaneLayout = 'side' | 'stacked'
export type SidebarSection = 'collections' | 'environments'

export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 520
export const SIDEBAR_DEFAULT = 300

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
  setTheme(theme: ThemePreference): void
  toggleSidebar(): void
  setSidebarWidth(width: number): void
  setSectionOpen(section: SidebarSection, open: boolean): void
  setLayout(layout: PaneLayout): void
}

const isSections = (v: unknown): v is Record<SidebarSection, boolean> =>
  typeof v === 'object' &&
  v !== null &&
  isBoolean((v as Record<string, unknown>).collections) &&
  isBoolean((v as Record<string, unknown>).environments)

export function loadUi(): Omit<UiState, `set${string}` | 'toggleSidebar'> {
  return {
    theme: loadTheme(),
    sidebarVisible: readPref('sidebarVisible', true, isBoolean),
    sidebarWidth: clampSidebar(readPref('sidebarWidth', SIDEBAR_DEFAULT, isNumber)),
    sections: readPref('sections', { collections: true, environments: true }, isSections),
    layout: readPref('layout', 'side', oneOf<PaneLayout>('side', 'stacked')),
  }
}

export const useUi = create<UiState>()((set, get) => ({
  ...loadUi(),
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
}))
