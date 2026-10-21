import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The UI font is bundled with the app; nothing is fetched at runtime.
import '@fontsource-variable/inter'
// The code font of the editors and method labels (IBM Plex Mono, OFL).
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/400-italic.css'
import '@fontsource/ibm-plex-mono/600.css'
import { App } from './App'
import { applyTheme, loadTheme } from './lib/theme'
import './styles.css'

applyTheme(loadTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
