import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { html } from '@codemirror/lang-html'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'

export type CodeLanguage = 'json' | 'text' | 'xml' | 'html' | 'javascript'

interface Props {
  value: string
  language: CodeLanguage
  onChange(value: string): void
  readOnly?: boolean
  /** Accessible name of the editor. */
  label?: string
}

/** Marks transactions that apply the `value` prop, so they are not reported back through `onChange`. */
const external = Annotation.define<boolean>()

function languageExtension(language: CodeLanguage): Extension {
  switch (language) {
    case 'json':
      return json()
    case 'xml':
      return xml()
    case 'html':
      return html()
    default:
      return [] // plain text; no JavaScript grammar is bundled
  }
}

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--bg)', fontSize: 'var(--text-sm)' },
  '&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--text)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--bg-selected)' },
})

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.propertyName, tags.attributeName], color: 'var(--syn-property)' },
    { tag: [tags.string, tags.attributeValue], color: 'var(--syn-string)' },
    { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
    { tag: [tags.tagName, tags.keyword], color: 'var(--syn-keyword)' },
    { tag: [tags.punctuation, tags.bracket, tags.separator], color: 'var(--syn-punct)' },
    { tag: [tags.comment, tags.meta], color: 'var(--text-muted)' },
    { tag: tags.invalid, color: 'var(--danger)' },
  ]),
)

/** Cmd/Ctrl+Enter is the "send" shortcut of the request editor, so the editor must not claim it. */
const keys = defaultKeymap.filter((binding) => binding.key !== 'Mod-Enter')

export function CodeEditor({ value, language, onChange, readOnly = false, label }: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const initial = useRef({ value, language, readOnly, label })
  const languageSlot = useRef(new Compartment())
  const readOnlySlot = useRef(new Compartment())
  const labelSlot = useRef(new Compartment())
  onChangeRef.current = onChange

  useEffect(() => {
    const start = initial.current
    const v = new EditorView({
      parent: host.current ?? undefined,
      state: EditorState.create({
        doc: start.value,
        extensions: [
          history(),
          keymap.of([...keys, ...historyKeymap]),
          EditorView.lineWrapping,
          theme,
          highlight,
          languageSlot.current.of(languageExtension(start.language)),
          readOnlySlot.current.of(EditorState.readOnly.of(start.readOnly)),
          labelSlot.current.of(EditorView.contentAttributes.of(start.label ? { 'aria-label': start.label } : {})),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((t) => t.annotation(external))) {
              onChangeRef.current(update.state.doc.toString())
            }
          }),
        ],
      }),
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
  }, [])

  useEffect(() => {
    const v = view.current
    if (!v) return
    const current = v.state.doc.toString()
    if (current === value) return
    // Replace only the differing middle so the cursor and scroll position survive an external update.
    let from = 0
    while (from < current.length && from < value.length && current[from] === value[from]) from++
    let end = current.length
    let newEnd = value.length
    while (end > from && newEnd > from && current[end - 1] === value[newEnd - 1]) {
      end--
      newEnd--
    }
    v.dispatch({ changes: { from, to: end, insert: value.slice(from, newEnd) }, annotations: external.of(true) })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: languageSlot.current.reconfigure(languageExtension(language)) })
  }, [language])

  useEffect(() => {
    view.current?.dispatch({ effects: readOnlySlot.current.reconfigure(EditorState.readOnly.of(readOnly)) })
  }, [readOnly])

  useEffect(() => {
    const attrs = EditorView.contentAttributes.of(label ? { 'aria-label': label } : {})
    view.current?.dispatch({ effects: labelSlot.current.reconfigure(attrs) })
  }, [label])

  return <div className="code-editor" ref={host} />
}
