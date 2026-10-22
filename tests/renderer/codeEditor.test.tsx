// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { acceptCompletion, closeCompletion, currentCompletions } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CodeEditor, type CodeEditorHandle } from '../../src/renderer/src/components/CodeEditor'
import type { Resolution } from '../../src/renderer/src/lib/variables'

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

  it('parses JavaScript in the javascript language', () => {
    render(<CodeEditor value="pm.test('ok', () => {})" language="javascript" onChange={() => {}} />)
    expect(syntaxTree(viewOf().state).topNode.name).toBe('Script')
  })

  it('switches language without recreating the document', () => {
    const { rerender } = render(<CodeEditor value="<a/>" language="text" onChange={() => {}} />)
    const before = viewOf()
    rerender(<CodeEditor value="<a/>" language="xml" onChange={() => {}} />)
    expect(viewOf()).toBe(before)
  })

  describe('{{ completion', () => {
    const OPTIONS: Resolution[] = [
      { name: 'baseUrl', value: 'http://h', secret: false, source: 'environment', scopeName: 'Dev' },
      { name: 'token', value: 'hunter2', secret: true, source: 'globals', scopeName: 'Globals' },
      { name: 'userBase', value: 'u', secret: false, source: 'collection', scopeName: 'Shop' },
    ]

    function typeAt(text: string, at: number) {
      act(() =>
        viewOf().dispatch({
          changes: { from: at, insert: text },
          selection: { anchor: at + text.length },
          userEvent: 'input.type',
        }),
      )
    }

    async function opened(): Promise<string[]> {
      await waitFor(() => expect(currentCompletions(viewOf().state).length).toBeGreaterThan(0))
      // CodeMirror ignores an accept within its interaction delay (75 ms) after opening.
      await new Promise((r) => setTimeout(r, 100))
      return currentCompletions(viewOf().state).map((c) => c.label)
    }

    it('offers the variables after {{, prefix matches first, and inserts name}}', async () => {
      const onChange = vi.fn()
      render(<CodeEditor value='{"a": ""}' language="json" onChange={onChange} variables completions={OPTIONS} />)
      typeAt('{{bas', 7)
      expect(await opened()).toEqual(['baseUrl', 'userBase'])
      act(() => {
        acceptCompletion(viewOf())
      })
      expect(viewOf().state.doc.toString()).toBe('{"a": "{{baseUrl}}"}')
      expect(viewOf().state.selection.main.head).toBe(18)
      expect(onChange).toHaveBeenLastCalledWith('{"a": "{{baseUrl}}"}')
    })

    it('does not add a second }} when one follows the caret', async () => {
      render(<CodeEditor value="{{}}" language="text" onChange={() => {}} variables completions={OPTIONS} />)
      typeAt('to', 2)
      expect(await opened()).toEqual(['token'])
      act(() => {
        acceptCompletion(viewOf())
      })
      expect(viewOf().state.doc.toString()).toBe('{{token}}')
      expect(viewOf().state.selection.main.head).toBe(9)
    })

    it('renders the value (secrets masked) and the source like the text inputs', async () => {
      render(<CodeEditor value="" language="text" onChange={() => {}} variables completions={OPTIONS} />)
      typeAt('{{', 0)
      expect(await opened()).toEqual(['baseUrl', 'token', 'userBase'])
      await waitFor(() => expect(document.querySelectorAll('.var-option')).toHaveLength(3))
      const token = document.querySelectorAll('.var-option')[1]
      expect(token.querySelector('.var-option-value')).toHaveTextContent('••••')
      expect(token).not.toHaveTextContent('hunter2')
      expect(token.querySelector('.var-option-source')).toHaveTextContent('Globals')
      expect(screen.getByRole('listbox')).toBeInTheDocument()
      act(() => {
        closeCompletion(viewOf())
      })
      expect(currentCompletions(viewOf().state)).toEqual([])
    })

    it('offers nothing without a match, outside {{, or without variables', async () => {
      const { unmount } = render(
        <CodeEditor value="" language="text" onChange={() => {}} variables completions={OPTIONS} />,
      )
      typeAt('{{zzz', 0)
      typeAt(' plain', 5)
      await new Promise((r) => setTimeout(r, 150))
      expect(currentCompletions(viewOf().state)).toEqual([])
      unmount()
      render(<CodeEditor value="" language="text" onChange={() => {}} completions={OPTIONS} />)
      typeAt('{{', 0)
      await new Promise((r) => setTimeout(r, 150))
      expect(currentCompletions(viewOf().state)).toEqual([])
    })
  })
})
