import { useState } from 'react'
import { useApp } from '../state/store'
import { LoadErrorsBanner } from './Banners'
import { ConfirmDialog } from './ConfirmDialog'
import { TreeView, type Edit } from './TreeView'
import { buildIndex, isContainer, type ItemKind } from './treeIndex'

export function Sidebar(): React.JSX.Element {
  const collections = useApp((s) => s.collections)
  const loadErrors = useApp((s) => s.loadErrors)
  const expanded = useApp((s) => s.expanded)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const { byPath } = buildIndex(collections, expanded)
  const deletingMeta = deleting === null ? undefined : byPath.get(deleting)

  function startCreate(kind: ItemKind, parentPath: string | null): void {
    if (parentPath !== null) useApp.getState().setExpanded(parentPath, true)
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

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar-header">
        <h2 className="sidebar-title">Collections</h2>
        <button type="button" className="btn" onClick={() => startCreate('collection', null)}>
          New collection
        </button>
      </div>
      <LoadErrorsBanner errors={loadErrors} />
      <div className="sidebar-body">
        <TreeView
          collections={collections}
          edit={edit}
          onCommitEdit={commitEdit}
          onCancelEdit={() => setEdit(null)}
          onStartCreate={startCreate}
          onStartRename={(path, initial) => setEdit({ mode: 'rename', path, initial })}
          onAskDelete={setDeleting}
        />
      </div>
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
