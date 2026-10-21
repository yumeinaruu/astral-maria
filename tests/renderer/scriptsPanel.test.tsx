// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { ScriptsPanel } from '../../src/renderer/src/components/request/ScriptsPanel'
import { initialState, useApp } from '../../src/renderer/src/state/store'
import type { RequestNode, Scripts } from '../../src/shared/types'
import { collectionTree, folderNode, installApi, REQUEST_PATH, requestNode, type MockApi } from './helpers'

// CodeMirror needs real layout; a textarea stands in for it here (tests/renderer/codeEditor.test.tsx covers the real one).
vi.mock('../../src/renderer/src/components/CodeEditor', () => ({
  CodeEditor: (p: { value: string; language: string; label?: string; onChange(v: string): void }) => (
    <textarea
      aria-label={p.label ?? 'code'}
      data-language={p.language}
      value={p.value}
      onChange={(e) => p.onChange(e.target.value)}
    />
  ),
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) })
  useApp.setState(initialState())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function openedEditor(scripts?: Scripts) {
  const node: RequestNode = requestNode(REQUEST_PATH, 'Get users')
  if (scripts) node.request.scripts = scripts
  const api = installApi({
    collections: {
      list: vi.fn().mockResolvedValue({
        collections: [collectionTree('collections/shop', 'Shop', [folderNode('collections/shop/users', 'Users', [node])])],
        errors: [],
      }),
    },
  })
  await useApp.getState().openWorkspace('/tmp/demo')
  useApp.getState().openRequest(REQUEST_PATH)
  render(<App />)
  return api
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const lastSaved = (api: MockApi) => api.collections.saveRequest.mock.lastCall
const sectionTabs = () => within(screen.getByRole('tablist', { name: 'Request sections' })).getAllByRole('tab')
const openScripts = () => fireEvent.click(screen.getByRole('tab', { name: /^Scripts/ }))
const scriptList = () => screen.getByRole('tablist', { name: 'Scripts' })

describe('request scripts', () => {
  it('adds a Scripts section after Body', async () => {
    await openedEditor()
    expect(sectionTabs().map((t) => t.textContent)).toEqual(['Params', 'Authorization', 'Headers', 'Body', 'Scripts'])
  })

  it('lists the two scripts vertically and edits the pre-request one in a JavaScript editor first', async () => {
    await openedEditor()
    openScripts()
    expect(scriptList()).toHaveAttribute('aria-orientation', 'vertical')
    const items = within(scriptList()).getAllByRole('tab')
    expect(items.map((t) => t.textContent)).toEqual(['Pre-request', 'Post-response'])
    expect(items[0]).toHaveAttribute('aria-selected', 'true')
    const editor = screen.getByRole('textbox', { name: 'Pre-request script' })
    expect(editor).toHaveAttribute('data-language', 'javascript')
    fireEvent.click(items[1]!)
    expect(screen.getByRole('textbox', { name: 'Post-response script' })).toBeInTheDocument()
  })

  it('marks the draft dirty and autosaves the scripts', async () => {
    const api = await openedEditor()
    openScripts()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Pre-request script' }), {
      target: { value: "pm.environment.set('a', '1')" },
    })
    expect(save).toBeEnabled()
    await tick(500)
    expect(lastSaved(api)![1].scripts).toEqual({ preRequest: "pm.environment.set('a', '1')", postResponse: '' })
  })

  it('removes scripts from the request when both are emptied', async () => {
    const api = await openedEditor({ preRequest: '', postResponse: 'pm.test("x", () => {})' })
    openScripts()
    fireEvent.click(within(scriptList()).getByRole('tab', { name: /Post-response/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Post-response script' }), { target: { value: '' } })
    await tick(500)
    expect(api.collections.saveRequest).toHaveBeenCalledTimes(1)
    expect(lastSaved(api)![1]).not.toHaveProperty('scripts')
  })

  it('shows a dot on each script that has content, and on the section', async () => {
    await openedEditor({ preRequest: '  \n', postResponse: 'pm.test("x", () => {})' })
    expect(screen.getByRole('tab', { name: /^Scripts/ })).toHaveTextContent('(configured)')
    openScripts()
    const [pre, post] = within(scriptList()).getAllByRole('tab')
    expect(pre!.querySelector('.config-dot')).toBeNull()
    expect(post!.querySelector('.config-dot')).not.toBeNull()
    expect(post).toHaveTextContent('Post-response (has a script)')

    fireEvent.change(screen.getByRole('textbox', { name: 'Pre-request script' }), { target: { value: 'x' } })
    expect(pre!.querySelector('.config-dot')).not.toBeNull()
  })

  it('shows no section dot without scripts', async () => {
    await openedEditor()
    expect(screen.getByRole('tab', { name: /^Scripts/ })).not.toHaveTextContent('(configured)')
  })

  it('moves between the two scripts with the arrow keys', () => {
    const onChange = vi.fn()
    render(<ScriptsPanel scripts={undefined} onChange={onChange} />)
    const [pre] = within(scriptList()).getAllByRole('tab')
    fireEvent.keyDown(pre!, { key: 'ArrowDown' })
    expect(within(scriptList()).getByRole('tab', { name: /Post-response/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Post-response script' })).toBeInTheDocument()
  })
})
