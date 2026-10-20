// Method list is defined in Task 8.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AstralApi {}

declare global {
  interface Window {
    astral: AstralApi
  }
}
