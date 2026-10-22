/// <reference types="electron-vite/node" />

// Vite's `?raw` imports: the file's contents as a string. Used for the scripts runtime (src/main/scripts/prelude.ts).
declare module '*?raw' {
  const text: string
  export default text
}
