import type { HttpMethod } from '../../../shared/types'

export function MethodBadge({ method }: { method: HttpMethod }): React.JSX.Element {
  return <span className={`method method-${method.toLowerCase()}`}>{method}</span>
}
