import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The UI font is bundled with the app; nothing is fetched at runtime.
import '@fontsource-variable/inter'
import { App } from './App'
import { applyTheme, loadTheme } from './lib/theme'
import './styles.css'

applyTheme(loadTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
