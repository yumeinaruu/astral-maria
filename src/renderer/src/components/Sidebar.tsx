import { ChevronDown, ChevronRight, ListFilter, MoreHorizontal, Plus } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { GLOBALS_NAME, newId, toDraft, uniqueName } from '../lib/environments'
import { useApp } from '../state/store'
import { SIDEBAR_MAX, SIDEBAR_MIN, useUi, type SidebarSection } from '../state/ui'
import { LoadErrorsBanner } from './Banners'
import { ConfirmDialog } from './ConfirmDialog'
import { EnvironmentList } from './EnvironmentList'
import { MenuButton } from './MenuButton'
import { TreeView, type Edit } from './TreeView'
import { buildIndex, isContainer, type ItemKind } from './treeIndex'

/** Opens the editor of a new, not yet saved environment. */
export function createEnvironment(): void {
  const names = [...useApp.getState().environments.map((e) => e.name), GLOBALS_NAME]
  const id = newId()
  useApp
    .getState()
    .openEnvironment(id, toDraft({ id, name: uniqueName('New environment', names), variables: [] }, true))
}

export function Sidebar(): React.JSX.Element {
  const collections = useApp((s) => s.collections)
  const loadErrors = useApp((s) => s.loadErrors)
  const expanded = useApp((s) => s.expanded)
  const width = useUi((s) => s.sidebarWidth)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const { byPath } = buildIndex(collections, expanded)
  const deletingMeta = deleting === null ? undefined : byPath.get(deleting)

  function startCreate(kind: ItemKind, parentPath: string | null): void {
    if (parentPath !== null) useApp.getState().setExpanded(parentPath, true)
    if (kind === 'collection') useUi.getState().setSectionOpen('collections', true)
    setFilter('')
    setEdit({ mode: 'create', kind, parentPath })
  }

  function commitEdit(name: string): void {
    const current = edit
    setEdit(null)
    if (!current) return
    const { createCollection, createFolder, createRequest, rename } = useApp.getState()
    if (current.mode === 'rename') void rename(current.path, name)
    else if (current.kind === 'collection') void createCollection(name)
    else if (current.parentPath !== null) {
      void (current.kind === 'folder' ? createFolder : createRequest)(current.parentPath, name)
    }
  }

  function confirmDelete(): void {
    const path = deleting
    setDeleting(null)
    if (path !== null) void useApp.getState().remove(path)
  }

  function collapseAll(): void {
    const { expanded: open, setExpanded } = useApp.getState()
    for (const path of Object.keys(open)) setExpanded(path, false)
  }

  return (
    <aside className="sidebar" aria-label="Sidebar" style={{ width }}>
      <div className="sidebar-tools">
        <label className="filter-box">
          <ListFilter size={14} aria-hidden="true" />
          <input
            className="filter-input"
            type="search"
            aria-label="Filter requests"
            placeholder="Filter"
            spellCheck={false}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFilter('')
            }}
          />
        </label>
        <button
          type="button"
          className="icon-btn"
          aria-label="New collection"
          title="New collection"
          onClick={() => startCreate('collection', null)}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <MenuButton
          label="More sidebar actions"
          items={[
            { label: 'New collection', onSelect: () => startCreate('collection', null) },
            { label: 'Collapse all', onSelect: collapseAll },
          ]}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </MenuButton>
      </div>
      <LoadErrorsBanner errors={loadErrors} />
      <div className="sidebar-scroll">
        <Section id="collections" title="Collections">
          <TreeView
            collections={collections}
            filter={filter}
            edit={edit}
            onCommitEdit={commitEdit}
            onCancelEdit={() => setEdit(null)}
            onStartCreate={startCreate}
            onStartRename={(path, initial) => setEdit({ mode: 'rename', path, initial })}
            onAskDelete={setDeleting}
          />
        </Section>
        <Section
          id="environments"
          title="Environments"
          actions={
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="New environment"
              title="New environment"
              onClick={createEnvironment}
            >
              <Plus size={15} aria-hidden="true" />
            </button>
          }
        >
          <EnvironmentList />
        </Section>
      </div>
      <SidebarResizer />
      {deletingMeta && (
        <ConfirmDialog
          title={`Delete ${deletingMeta.kind}`}
          message={`Delete "${deletingMeta.name}"?${isContainer(deletingMeta.kind) ? ' Everything inside it is deleted too.' : ''} This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </aside>
  )
}

interface SectionProps {
  id: SidebarSection
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
}

/** A collapsible sidebar section; whether it is open is remembered on this machine. */
function Section({ id, title, actions, children }: SectionProps): React.JSX.Element {
  const open = useUi((s) => s.sections[id])
  const bodyId = useId()
  return (
    <section className="sidebar-section" aria-label={title}>
      <div className="section-header">
        <button
          type="button"
          className="section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => useUi.getState().setSectionOpen(id, !open)}
        >
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          {title}
        </button>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      <div id={bodyId} hidden={!open}>
        {open && children}
      </div>
    </section>
  )
}

const KEY_STEP = 16

/** The draggable right edge of the sidebar; also resizable with the arrow keys. */
function SidebarResizer(): React.JSX.Element {
  const width = useUi((s) => s.sidebarWidth)
  const start = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const set = (w: number): void => useUi.getState().setSidebarWidth(w)

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      className={`sidebar-resizer${dragging ? ' dragging' : ''}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, width }
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (start.current && e.currentTarget.hasPointerCapture(e.pointerId)) {
          set(start.current.width + e.clientX - start.current.x)
        }
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId)
        start.current = null
        setDragging(false)
      }}
      onKeyDown={(e) => {
        const next =
          e.key === 'ArrowRight'
            ? width + KEY_STEP
            : e.key === 'ArrowLeft'
              ? width - KEY_STEP
              : e.key === 'Home'
                ? SIDEBAR_MIN
                : e.key === 'End'
                  ? SIDEBAR_MAX
                  : null
        if (next === null) return
        e.preventDefault()
        set(next)
      }}
    />
  )
}
