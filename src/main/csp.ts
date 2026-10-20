const BASE = {
  'default-src': ["'self'"],
  'connect-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'style-src': ["'self'", "'unsafe-inline'"]
}

/** Strict policy for production; pass `dev` to also allow Vite HMR and React Refresh. */
export function buildCsp(dev?: { wsOrigin: string }): string {
  const directives: Record<string, string[]> = { ...BASE }
  if (dev) {
    directives['script-src'] = ["'self'", "'unsafe-inline'"]
    directives['connect-src'] = [...BASE['connect-src'], dev.wsOrigin]
  }
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ')
}
