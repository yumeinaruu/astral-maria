// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CodeEditor, type CodeEditorHandle } from '../../src/renderer/src/components/CodeEditor'

// jsdom has no layout and Range lacks the geometry methods CodeMirror measures with; stub them and restore afterwards.
const rangeStubs = {
  getClientRects: () => [] as unknown as DOMRectList,
  getBoundingClientRect: () => new DOMRect(),
}
const rangeBackup: Partial<Record<keyof typeof rangeStubs, PropertyDescriptor>> = {}

beforeAll(() => {
  for (const name of Object.keys(rangeStubs) as (keyof typeof rangeStubs)[]) {
    rangeBackup[name] = Object.getOwnPropertyDescriptor(Range.prototype, name)
    Object.defineProperty(Range.prototype, name, { value: rangeStubs[name], configurable: true, writable: true })
  }
})
afterAll(() => {
  for (const name of Object.keys(rangeStubs) as (keyof typeof rangeStubs)[]) {
    const original = rangeBackup[name]
    if (original) Object.defineProperty(Range.prototype, name, original)
    else delete (Range.prototype as unknown as Record<string, unknown>)[name]
  }
})
afterEach(cleanup)

function viewOf(): EditorView {
  const dom = document.querySelector('.cm-editor') as HTMLElement
  const view = EditorView.findFromDOM(dom)
  if (!view) throw new Error('no editor view')
  return view
}

describe('CodeEditor', () => {
  it('shows the value and reports typing through onChange', async () => {
    const onChange = vi.fn()
    render(<CodeEditor value='{"a":1}' language="json" onChange={onChange} label="Body" />)
    const textbox = screen.getByRole('textbox', { name: 'Body' })
    expect(textbox).toHaveTextContent('{"a":1}')
    await userEvent.setup().click(textbox)
    act(() => viewOf().dispatch({ changes: { from: 7, insert: ' ' }, userEvent: 'input.type' }))
    expect(onChange).toHaveBeenCalledWith('{"a":1} ')
  })

  it('applies external value changes without calling onChange and keeps the cursor', () => {
    const onChange = vi.fn()
    const { rerender } = render(<CodeEditor value="hello world" language="text" onChange={onChange} />)
    act(() => viewOf().dispatch({ selection: { anchor: 11 } }))
    rerender(<CodeEditor value="hello brave world" language="text" onChange={onChange} />)
    expect(viewOf().state.doc.toString()).toBe('hello brave world')
    expect(viewOf().state.selection.main.head).toBe(17)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not rewrite the document when the value came from the editor itself', () => {
    const onChange = vi.fn()
    const { rerender } = render(<CodeEditor value="a" language="text" onChange={onChange} />)
    act(() => viewOf().dispatch({ changes: { from: 1, insert: 'b' }, selection: { anchor: 1 } }))
    expect(onChange).toHaveBeenCalledWith('ab')
    rerender(<CodeEditor value="ab" language="text" onChange={onChange} />)
    expect(viewOf().state.selection.main.head).toBe(1)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('is read-only on request and destroys the view on unmount', () => {
    const onChange = vi.fn()
    const { unmount } = render(<CodeEditor value="x" language="xml" onChange={onChange} readOnly />)
    expect(viewOf().state.readOnly).toBe(true)
    unmount()
    expect(document.querySelector('.cm-editor')).toBeNull()
  })

  it('marks {{variables}} when asked to and opens the search panel on request', () => {
    const handle: { current: CodeEditorHandle | null } = { current: null }
    render(<CodeEditor value='{"u":"{{user}}"}' language="json" onChange={() => {}} variables ref={handle} />)
    expect(document.querySelector('.cm-var')).toHaveTextContent('{{user}}')
    act(() => handle.current!.openSearch())
    expect(document.querySelector('.cm-search')).not.toBeNull()
  })

  it('shows line numbers and toggles wrapping without recreating the view', () => {
    const { rerender } = render(<CodeEditor value="a" language="text" onChange={() => {}} />)
    const before = viewOf()
    expect(document.querySelector('.cm-lineNumbers')).not.toBeNull()
    expect(document.querySelector('.cm-lineWrapping')).not.toBeNull()
    rerender(<CodeEditor value="a" language="text" onChange={() => {}} wrap={false} />)
    expect(viewOf()).toBe(before)
    expect(document.querySelector('.cm-lineWrapping')).toBeNull()
  })

  it('switches language without recreating the document', () => {
    const { rerender } = render(<CodeEditor value="<a/>" language="text" onChange={() => {}} />)
    const before = viewOf()
    rerender(<CodeEditor value="<a/>" language="xml" onChange={() => {}} />)
    expect(viewOf()).toBe(before)
  })
})
