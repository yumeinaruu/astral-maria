import { useEffect, useMemo, useRef, useState } from 'react'
import type { CollectionTree } from '../../../shared/types'
import { useApp } from '../state/store'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { MethodBadge } from './MethodBadge'
import { NameInput } from './NameInput'
import { buildIndex, isContainer, isWithin, type ItemKind, type ItemMeta } from './treeIndex'

export type Edit =
  { mode: 'create'; kind: ItemKind; parentPath: string | null } | { mode: 'rename'; path: string; initial: string }

interface Props {
  collections: CollectionTree[]
  edit: Edit | null
  onCommitEdit(name: string): void
  onCancelEdit(): void
  onStartCreate(kind: ItemKind, parentPath: string | null): void
  onStartRename(path: string, initial: string): void
  onAskDelete(path: string): void
}

interface MenuState {
  path: string
  x: number
  y: number
}

const itemId = (path: string): string => `treeitem-${encodeURIComponent(path)}`

export function TreeView({
  collections,
  edit,
  onCommitEdit,
  onCancelEdit,
  onStartCreate,
  onStartRename,
  onAskDelete,
}: Props): React.JSX.Element {
  const expanded = useApp((s) => s.expanded)
  const activePath = useApp((s) => s.activePath)
  const setExpanded = useApp((s) => s.setExpanded)
  const openRequest = useApp((s) => s.openRequest)
  const move = useApp((s) => s.move)

  const index = useMemo(() => buildIndex(collections, expanded), [collections, expanded])
  const [focused, setFocused] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dragging = useRef<string | null>(null)
  const treeRef = useRef<HTMLUListElement>(null)
  const editing = edit !== null

  // Hand focus back to the tree when an inline edit ends, so keyboard use continues.
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !editing) treeRef.current?.focus()
    wasEditing.current = editing
  }, [editing])

  const current = focused !== null && index.byPath.has(focused) && index.visible.includes(focused) ? focused : null

  function toggle(meta: ItemMeta): void {
    setExpanded(meta.path, !expanded[meta.path])
  }

  function activate(meta: ItemMeta): void {
    setFocused(meta.path)
    if (meta.kind === 'request') openRequest(meta.path)
    else toggle(meta)
  }

  function openMenu(path: string, x: number, y: number): void {
    setFocused(path)
    setMenu({ path, x, y })
  }

  function menuItems(meta: ItemMeta): MenuItem[] {
    const items: MenuItem[] = []
    if (isContainer(meta.kind)) {
      items.push(
        { label: 'New folder', onSelect: () => onStartCreate('folder', meta.path) },
        { label: 'New request', onSelect: () => onStartCreate('request', meta.path) },
      )
    }
    items.push(
      { label: 'Rename', onSelect: () => onStartRename(meta.path, meta.name) },
      { label: 'Delete', onSelect: () => onAskDelete(meta.path) },
    )
    return items
  }

  function closeMenu(): void {
    setMenu(null)
    treeRef.current?.focus()
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.target !== e.currentTarget) return
    const { visible, byPath } = index
    const at = current === null ? -1 : visible.indexOf(current)
    const meta = current === null ? undefined : byPath.get(current)
    const select = (i: number): void => {
      e.preventDefault()
      const path = visible[Math.max(0, Math.min(i, visible.length - 1))]
      if (path !== undefined) setFocused(path)
    }
    switch (e.key) {
      case 'ArrowDown':
        return select(at + 1)
      case 'ArrowUp':
        return select(at < 0 ? 0 : at - 1)
      case 'Home':
        return select(0)
      case 'End':
        return select(visible.length - 1)
      case 'ArrowRight':
        if (!meta || !isContainer(meta.kind)) return
        e.preventDefault()
        if (!expanded[meta.path]) setExpanded(meta.path, true)
        else if (meta.childPaths[0] !== undefined) setFocused(meta.childPaths[0])
        return
      case 'ArrowLeft':
        if (!meta) return
        e.preventDefault()
        if (isContainer(meta.kind) && expanded[meta.path]) setExpanded(meta.path, false)
        else if (meta.parentPath !== null) setFocused(meta.parentPath)
        return
      case 'Enter':
        if (!meta) return
        e.preventDefault()
        return activate(meta)
      case 'F2':
        if (!meta) return
        e.preventDefault()
        return onStartRename(meta.path, meta.name)
      case 'Delete':
        if (!meta) return
        e.preventDefault()
        return onAskDelete(meta.path)
      case 'ContextMenu':
      case 'F10': {
        if (!meta || (e.key === 'F10' && !e.shiftKey)) return
        e.preventDefault()
        const rect = document.getElementById(itemId(meta.path))?.getBoundingClientRect()
        return openMenu(meta.path, rect?.left ?? 0, (rect?.top ?? 0) + 24)
      }
    }
  }

  // ---- drag and drop ----

  /** Where dropping the dragged item on `target` would put it, or null when that is not allowed. */
  function dropPlace(target: ItemMeta): { parentPath: string; index: number } | null {
    const from = dragging.current
    const source = from === null ? undefined : index.byPath.get(from)
    if (!from || !source || source.kind === 'collection' || target.path === from) return null
    const parentPath = isContainer(target.kind) ? target.path : target.parentPath
    if (parentPath === null || isWithin(parentPath, from)) return null
    const others = (isContainer(target.kind) ? target.childPaths : target.siblingPaths).filter((p) => p !== from)
    return { parentPath, index: isContainer(target.kind) ? others.length : others.indexOf(target.path) }
  }

  function dragHandlers(meta: ItemMeta): React.HTMLAttributes<HTMLLIElement> {
    return {
      draggable: meta.kind !== 'collection' && !editing,
      onDragStart(e) {
        e.stopPropagation()
        dragging.current = meta.path
        e.dataTransfer.setData('text/plain', meta.path)
        e.dataTransfer.effectAllowed = 'move'
      },
      onDragOver(e) {
        e.stopPropagation()
        if (!dropPlace(meta)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropTarget(meta.path)
      },
      onDrop(e) {
        e.stopPropagation()
        const place = dropPlace(meta)
        const from = dragging.current
        dragging.current = null
        setDropTarget(null)
        if (!place || !from) return
        e.preventDefault()
        void move(from, place.parentPath, place.index)
      },
      onDragEnd() {
        dragging.current = null
        setDropTarget(null)
      },
    }
  }

  // ---- rendering ----

  function renderItem(meta: ItemMeta, depth: number, children: React.ReactNode): React.JSX.Element {
    const container = isContainer(meta.kind)
    const open = container && Boolean(expanded[meta.path])
    const renaming = edit?.mode === 'rename' && edit.path === meta.path
    const classes = [
      'tree-item',
      current === meta.path ? 'focused' : '',
      activePath === meta.path ? 'active' : '',
      dropTarget === meta.path ? 'drop-target' : '',
    ]
    return (
      <li
        key={meta.path}
        id={itemId(meta.path)}
        role="treeitem"
        aria-label={meta.name}
        aria-level={depth + 1}
        aria-expanded={container ? open : undefined}
        aria-selected={current === meta.path}
        className={classes.filter(Boolean).join(' ')}
        onClick={(e) => {
          e.stopPropagation()
          treeRef.current?.focus()
          activate(meta)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          openMenu(meta.path, e.clientX, e.clientY)
        }}
        {...dragHandlers(meta)}
      >
        <div className="tree-row" style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--indent))` }}>
          <span className="twisty" aria-hidden="true">
            {container ? (open ? '▾' : '▸') : ''}
          </span>
          {meta.method && <MethodBadge method={meta.method} />}
          {renaming ? (
            <NameInput initial={edit.initial} onCommit={onCommitEdit} onCancel={onCancelEdit} />
          ) : (
            <span className={meta.kind === 'collection' ? 'tree-name tree-name-collection' : 'tree-name'}>
              {meta.name}
            </span>
          )}
          <button
            type="button"
            className="row-menu"
            tabIndex={-1}
            aria-label={`Actions for ${meta.name}`}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              openMenu(meta.path, rect.left, rect.bottom)
            }}
          >
            …
          </button>
        </div>
        {open && (
          <ul role="group" className="tree-group">
            {edit?.mode === 'create' && edit.parentPath === meta.path && (
              <CreateRow depth={depth + 1} onCommit={onCommitEdit} onCancel={onCancelEdit} />
            )}
            {children}
          </ul>
        )}
      </li>
    )
  }

  function renderNodes(paths: string[], depth: number): React.ReactNode {
    return paths.map((path) => {
      const meta = index.byPath.get(path)
      if (!meta) return null
      const open = isContainer(meta.kind) && Boolean(expanded[path])
      return renderItem(meta, depth, open ? renderNodes(meta.childPaths, depth + 1) : null)
    })
  }

  const menuMeta = menu ? index.byPath.get(menu.path) : undefined

  return (
    <>
      <ul
        ref={treeRef}
        className="tree"
        role="tree"
        aria-label="Collections"
        tabIndex={0}
        aria-activedescendant={current === null ? undefined : itemId(current)}
        onKeyDown={onKeyDown}
      >
        {edit?.mode === 'create' && edit.parentPath === null && (
          <CreateRow depth={0} onCommit={onCommitEdit} onCancel={onCancelEdit} />
        )}
        {renderNodes(
          collections.map((c) => c.path),
          0,
        )}
      </ul>
      {collections.length === 0 && edit === null && <p className="muted empty">No collections yet.</p>}
      {menu && menuMeta && (
        <ContextMenu x={menu.x} y={menu.y} label={menuMeta.name} items={menuItems(menuMeta)} onClose={closeMenu} />
      )}
    </>
  )
}

function CreateRow({ depth, onCommit, onCancel }: { depth: number; onCommit(n: string): void; onCancel(): void }) {
  return (
    <li role="none">
      <div className="tree-row" style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--indent))` }}>
        <span className="twisty" aria-hidden="true" />
        <NameInput onCommit={onCommit} onCancel={onCancel} />
      </div>
    </li>
  )
}
