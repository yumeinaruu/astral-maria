import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { buildCsp } from './src/main/csp'

const productionCsp = buildCsp()

function devCsp(): Plugin {
  let wsOrigin = 'ws://localhost:5173'
  return {
    name: 'astral-maria-dev-csp',
    apply: 'serve',
    configResolved(config) {
      const host = typeof config.server.host === 'string' ? config.server.host : 'localhost'
      wsOrigin = `ws://${host}:${config.server.port ?? 5173}`
    },
    transformIndexHtml: (html) => html.replace(productionCsp, buildCsp({ wsOrigin }))
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), devCsp()]
  }
})
