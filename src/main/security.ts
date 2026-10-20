export function isAllowedRendererUrl(url: string, devServerUrl?: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'file:' || parsed.protocol === 'devtools:') return true
  if (devServerUrl) {
    try {
      const dev = new URL(devServerUrl)
      const sameHost = parsed.host === dev.host
      const isSocket = parsed.protocol === 'ws:' || parsed.protocol === 'wss:'
      return sameHost && (parsed.protocol === dev.protocol || isSocket)
    } catch {
      return false
    }
  }
  return false
}
