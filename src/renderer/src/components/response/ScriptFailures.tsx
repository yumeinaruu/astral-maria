import { CircleAlert } from 'lucide-react'
import type { ScriptFailure } from '../../../../shared/types'

/** One error strip per script that failed: `Error in <phase> script of <source>: <message>`. */
export function ScriptFailures({ failures }: { failures: ScriptFailure[] }): React.JSX.Element | null {
  if (failures.length === 0) return null
  return (
    <div className="script-failures">
      {failures.map((f, i) => (
        <p key={i} role="alert" className="script-failure">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{`Error in ${f.phase} script of ${f.source}: ${f.message}`}</span>
        </p>
      ))}
    </div>
  )
}
