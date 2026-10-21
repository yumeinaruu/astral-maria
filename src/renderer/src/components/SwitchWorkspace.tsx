import { useState } from 'react'
import { useApp } from '../state/store'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * "Switch workspace…": writes all drafts, closes the workspace and returns to the gate (with its recent list). If some
 * changes could not be written, `dialog` asks before discarding them.
 */
export function useSwitchWorkspace(): { busy: boolean; start(): void; dialog: React.ReactNode } {
  const [busy, setBusy] = useState(false)
  const [unsaved, setUnsaved] = useState<string[] | null>(null)

  async function leave(discardUnsaved: boolean): Promise<void> {
    setUnsaved(null)
    setBusy(true)
    try {
      const store = useApp.getState()
      if ((await store.leaveWorkspace({ discardUnsaved })) === 'unsaved') setUnsaved(store.unsavedPaths())
    } finally {
      setBusy(false)
    }
  }

  return {
    busy,
    start: () => {
      if (!busy) void leave(false)
    },
    dialog: unsaved && (
      <ConfirmDialog
        title="Unsaved changes"
        message={`These changes could not be saved: ${unsaved.join(', ')}. Switch workspace and discard them?`}
        confirmLabel="Discard and switch"
        onConfirm={() => void leave(true)}
        onCancel={() => setUnsaved(null)}
      />
    ),
  }
}
