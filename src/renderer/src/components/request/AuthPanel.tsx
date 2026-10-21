import { Ban, CornerLeftUp, Key, KeyRound, UserRound, type LucideIcon } from 'lucide-react'
import { useId } from 'react'
import type { Auth } from '../../../../shared/types'
import { MASK } from '../../lib/variables'
import { useApp } from '../../state/store'
import { Dropdown } from '../Dropdown'
import { VarInput, VarText } from '../VarInput'
import { recall, remember, type PanelProps } from './switching'

const AUTH_TYPES: { value: Auth['type']; label: string }[] = [
  { value: 'inherit', label: 'Inherit from parent' },
  { value: 'none', label: 'No auth' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'basic', label: 'Basic auth' },
  { value: 'apikey', label: 'API key' },
]

const ICONS: Record<Auth['type'], LucideIcon> = {
  inherit: CornerLeftUp,
  none: Ban,
  bearer: KeyRound,
  basic: UserRound,
  apikey: Key,
}

const HELP: Record<Auth['type'], string> = {
  inherit:
    'The request uses the authorization of its collection. Change it there to change every request that inherits it.',
  none: 'This request does not use any authorization.',
  bearer: 'The Authorization header is generated from the token when you send the request.',
  basic: 'The Authorization header is generated from the username and password when you send the request.',
  apikey: 'The key and value are added as a header or a query parameter when you send the request.',
}

const ADD_TO: { value: 'header' | 'query'; label: string }[] = [
  { value: 'header', label: 'Header' },
  { value: 'query', label: 'Query params' },
]

const EMPTY_AUTHS: { [T in Auth['type']]: Extract<Auth, { type: T }> } = {
  inherit: { type: 'inherit' },
  none: { type: 'none' },
  bearer: { type: 'bearer', token: '' },
  basic: { type: 'basic', username: '', password: '' },
  apikey: { type: 'apikey', key: '', value: '', in: 'header' },
}

const labelOf = (type: Auth['type']): string => AUTH_TYPES.find((t) => t.value === type)!.label

function TypeIcon({ type }: { type: Auth['type'] }): React.JSX.Element {
  const Icon = ICONS[type]
  return <Icon className="auth-glyph" size={14} aria-hidden="true" />
}

/** Two columns: the type with its help on the left, its fields on the right. */
export function AuthPanel({ draft, edit, path }: PanelProps & { path: string }): React.JSX.Element {
  const { auth } = draft
  const patch = (change: Partial<Auth>): void => edit({ auth: { ...auth, ...change } as Auth })

  function switchTo(type: Auth['type']): void {
    if (type === auth.type) return
    remember(draft.id, 'auth', auth)
    edit({ auth: recall(draft.id, 'auth', type, EMPTY_AUTHS[type]) })
  }

  return (
    <div className="auth-panel">
      <div className="auth-side">
        <span className="auth-label">Auth type</span>
        <Dropdown
          label="Auth type"
          className="bordered-dropdown"
          icon={<TypeIcon type={auth.type} />}
          value={auth.type}
          options={AUTH_TYPES}
          onChange={switchTo}
        />
        <p className="auth-help">{HELP[auth.type]}</p>
      </div>
      <div className="auth-fields">
        {auth.type === 'inherit' && <Inherited path={path} />}
        {auth.type === 'none' && <p className="muted">No authorization is added.</p>}
        {auth.type === 'bearer' && <Field label="Token" value={auth.token} onChange={(token) => patch({ token })} />}
        {auth.type === 'basic' && (
          <>
            <Field label="Username" value={auth.username} onChange={(username) => patch({ username })} />
            <Field label="Password" password value={auth.password} onChange={(password) => patch({ password })} />
          </>
        )}
        {auth.type === 'apikey' && (
          <>
            <Field label="Key" value={auth.key} onChange={(key) => patch({ key })} />
            <Field label="Value" value={auth.value} onChange={(value) => patch({ value })} />
            <div className="auth-field">
              <span className="auth-field-label">Add to</span>
              <Dropdown
                label="Add to"
                className="bordered-dropdown"
                value={auth.in}
                options={ADD_TO}
                onChange={(where) => patch({ in: where })}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

interface FieldProps {
  label: string
  value: string
  onChange(value: string): void
  password?: boolean
}

function Field({ label, value, onChange, password }: FieldProps): React.JSX.Element {
  const id = useId()
  return (
    <div className="auth-field">
      <label className="auth-field-label" htmlFor={id}>
        {label}
      </label>
      {password ? (
        <input
          id={id}
          className="text-input auth-input"
          type="password"
          value={value}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <VarInput id={id} className="text-input auth-input" value={value} onChange={onChange} />
      )}
    </div>
  )
}

/** The collection's auth, read-only, for a request that inherits it. */
function Inherited({ path }: { path: string }): React.JSX.Element {
  const parent = useApp((s) => s.collections.find((c) => path.startsWith(`${c.path}/`)))
  const name = parent?.name ?? 'the collection'
  // The main process sends a collection's `inherit` as no auth.
  const auth: Auth = !parent || parent.auth.type === 'inherit' ? { type: 'none' } : parent.auth

  return (
    <div className="auth-inherited">
      <div className="auth-inherited-head">
        <strong>{labelOf(auth.type)}</strong>
        <span className="chip">Inherited</span>
      </div>
      <p className="muted">From {name}.</p>
      {auth.type !== 'none' && (
        <>
          <ReadOnly label="Auth type">
            <TypeIcon type={auth.type} />
            {labelOf(auth.type)}
          </ReadOnly>
          {auth.type === 'bearer' && (
            <ReadOnly label="Token">
              <VarText text={auth.token} />
            </ReadOnly>
          )}
          {auth.type === 'basic' && (
            <>
              <ReadOnly label="Username">
                <VarText text={auth.username} />
              </ReadOnly>
              <ReadOnly label="Password">{auth.password ? MASK : ''}</ReadOnly>
            </>
          )}
          {auth.type === 'apikey' && (
            <>
              <ReadOnly label="Key">
                <VarText text={auth.key} />
              </ReadOnly>
              <ReadOnly label="Value">
                <VarText text={auth.value} />
              </ReadOnly>
              <ReadOnly label="Add to">{auth.in === 'query' ? 'Query params' : 'Header'}</ReadOnly>
            </>
          )}
        </>
      )}
    </div>
  )
}

function ReadOnly({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="auth-field">
      <span className="auth-field-label">{label}</span>
      <div className="readonly-box" aria-label={label} role="group">
        {children}
      </div>
    </div>
  )
}
