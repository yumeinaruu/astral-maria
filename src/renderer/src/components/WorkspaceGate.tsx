import { FolderOpen, FolderPlus, GitBranch } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WorkspaceInfo } from '../../../shared/types'
import { useApp } from '../state/store'
import { OpenFromGitDialog } from './sync/OpenFromGitDialog'

export function WorkspaceGate(): React.JSX.Element {
  const openWorkspace = useApp((s) => s.openWorkspace)
  const createWorkspace = useApp((s) => s.createWorkspace)
  const [recent, setRecent] = useState<WorkspaceInfo[]>([])
  const [pendingDir, setPendingDir] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [cloneOpen, setCloneOpen] = useState(false)

  useEffect(() => {
    window.astral.workspace
      .recent()
      .then(setRecent)
      .catch((e: unknown) => useApp.setState({ error: e instanceof Error ? e.message : String(e) }))
  }, [])

  async function pick(): Promise<string | null> {
    try {
      return await window.astral.workspace.pickDirectory()
    } catch (e) {
      useApp.setState({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  async function onOpen(): Promise<void> {
    const dir = await pick()
    if (dir) await openWorkspace(dir)
  }

  async function onCreate(): Promise<void> {
    const dir = await pick()
    if (dir) {
      setName('')
      setPendingDir(dir)
    }
  }

  function submit(e: React.FormEvent): void {
    e.preventDefault()
    const trimmed = name.trim()
    if (pendingDir && trimmed) void createWorkspace(pendingDir, trimmed)
  }

  return (
    <main className="gate">
      <div className="gate-card">
        <div>
          <h1 className="gate-title">Astral Maria</h1>
          <p className="muted">A local API client. Everything stays in a folder on this computer.</p>
        </div>
        <div className="gate-actions">
          <button type="button" className="btn btn-primary" onClick={() => void onCreate()}>
            <FolderPlus size={15} aria-hidden="true" />
            Create workspace
          </button>
          <button type="button" className="btn" onClick={() => void onOpen()}>
            <FolderOpen size={15} aria-hidden="true" />
            Open workspace
          </button>
          <button type="button" className="btn" onClick={() => setCloneOpen(true)}>
            <GitBranch size={15} aria-hidden="true" />
            Open from Git
          </button>
        </div>
        {pendingDir && (
          <form className="gate-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && setPendingDir(null)}>
            <p className="muted">
              Folder: <code className="mono">{pendingDir}</code>
            </p>
            <label htmlFor="workspace-name">Workspace name</label>
            <input
              id="workspace-name"
              className="text-input"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="gate-actions">
              <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
                Create
              </button>
              <button type="button" className="btn" onClick={() => setPendingDir(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {recent.length > 0 && (
          <section aria-labelledby="recent-heading" className="gate-recent">
            <h2 id="recent-heading">Recent workspaces</h2>
            <ul className="recent-list">
              {recent.map((w) => (
                <li key={w.id}>
                  <button type="button" className="recent-item" onClick={() => void openWorkspace(w.dir)}>
                    <span className="recent-name">{w.name}</span>
                    <span className="recent-dir">{w.dir}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {cloneOpen && <OpenFromGitDialog onClose={() => setCloneOpen(false)} />}
    </main>
  )
}
