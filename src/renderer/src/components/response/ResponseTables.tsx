import type { ParsedCookie } from '../../../../shared/types'

export function HeadersTable({ headers }: { headers: [string, string][] }): React.JSX.Element {
  if (headers.length === 0) return <p className="muted panel-empty">No headers.</p>
  return (
    <table className="grid-table response-table">
      <thead>
        <tr>
          <th scope="col">Key</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {headers.map(([name, value], i) => (
          <tr key={i}>
            <td>{name}</td>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const FLAGS = ['httponly', 'secure']

export function CookiesTable({ cookies }: { cookies: ParsedCookie[] }): React.JSX.Element {
  if (cookies.length === 0) return <p className="muted panel-empty">No cookies.</p>
  return (
    <table className="grid-table response-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Value</th>
          <th scope="col">Attributes</th>
        </tr>
      </thead>
      <tbody>
        {cookies.map((c, i) => {
          const entries = Object.entries(c.attributes)
          const flags = entries.filter(([k]) => FLAGS.includes(k.toLowerCase()))
          const others = entries.filter(([k]) => !FLAGS.includes(k.toLowerCase()))
          return (
            <tr key={i}>
              <td>{c.name}</td>
              <td>{c.value}</td>
              <td className="cookie-attrs">
                {flags.map(([k]) => (
                  <span key={k} className="chip">
                    {k}
                  </span>
                ))}
                {others.length > 0 && (
                  <span className="muted">{others.map(([k, v]) => (v === true ? k : `${k}=${v}`)).join('; ')}</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
