import {
  acceptCompletion,
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { html } from '@codemirror/lang-html'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useImperativeHandle, useRef } from 'react'
import { filterOptions, insertCompletion, optionValue } from '../lib/completion'
import { SOURCE_LABELS, type Resolution } from '../lib/variables'

export type CodeLanguage = 'json' | 'text' | 'xml' | 'html' | 'javascript'

interface Props {
  value: string
  language: CodeLanguage
  onChange(value: string): void
  readOnly?: boolean
  /** Accessible name of the editor. */
  label?: string
  /** Long lines wrap (the default) instead of scrolling sideways. */
  wrap?: boolean
  /** Colours `{{variables}}` (request bodies). */
  variables?: boolean
  /** With `variables`: the variables offered when `{{` is typed. */
  completions?: Resolution[] | null
  /** Imperative access for toolbar buttons. */
  ref?: React.Ref<CodeEditorHandle>
}

export interface CodeEditorHandle {
  /** Opens the search panel (also Cmd/Ctrl+F inside the editor). */
  openSearch(): void
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

/**
 * One theme for both palettes: every colour is a CSS token, so the editor follows the light/dark switch live without
 * being reconfigured.
 */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--code-text)',
    backgroundColor: 'var(--background-primary)',
    fontSize: 'var(--text-size-m)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-family-code)', lineHeight: 'var(--line-height-code)' },
  '.cm-content': { caretColor: 'var(--code-text)', padding: '4px 0' },
  '.cm-line': { padding: '0 12px 0 8px' },
  '&.cm-focused .cm-cursor, .cm-cursor': { borderLeftColor: 'var(--code-text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--code-selection)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--code-active-line)' },
  '.cm-gutters': { backgroundColor: 'var(--background-primary)', color: 'var(--code-gutter)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 0', minWidth: '36px', textAlign: 'right' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--code-gutter-active)' },
  // The mark can wrap the string token's own span, so its children take the colour too.
  '.cm-var, .cm-var *': { color: 'var(--code-var)', fontStyle: 'italic' },
  '.cm-searchMatch': { backgroundColor: 'var(--code-match)', outline: '1px solid var(--code-match-border)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--code-match-border)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--code-selection)' },
  '.cm-panels': { backgroundColor: 'var(--background-secondary)', color: 'var(--code-text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-default)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border-default)' },
  '.cm-search': { fontFamily: 'var(--font-family-ui)', fontSize: 'var(--text-size-s)', padding: '6px 8px' },
  '.cm-search input, .cm-search button, .cm-search label': {
    fontSize: 'var(--text-size-s)',
    fontFamily: 'var(--font-family-ui)',
  },
  '.cm-textfield': {
    color: 'var(--code-text)',
    backgroundColor: 'var(--background-primary)',
    border: '1px solid var(--border-input)',
    borderRadius: 'var(--radius-s)',
    padding: '2px 6px',
  },
  '.cm-textfield:focus': { borderColor: 'var(--border-focus)', outline: 'none' },
  '.cm-button': {
    color: 'var(--code-text)',
    backgroundImage: 'none',
    backgroundColor: 'var(--button-secondary)',
    border: '0',
    borderRadius: 'var(--radius-s)',
    padding: '2px 8px',
  },
  '.cm-panel.cm-search [name=close]': { color: 'var(--code-gutter-active)' },
})

const variableMatcher = new MatchDecorator({
  regexp: /\{\{[^{}]*\}\}/g,
  decoration: Decoration.mark({ class: 'cm-var' }),
})

/** Marks `{{variables}}` in the document. */
const variableMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = variableMatcher.createDeco(view)
    }
    update(update: ViewUpdate) {
      this.decorations = variableMatcher.updateDeco(update, this.decorations)
    }
  },
  { decorations: (v) => v.decorations },
)

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.propertyName, tags.attributeName], color: 'var(--code-property)' },
    { tag: [tags.string, tags.attributeValue], color: 'var(--code-string)' },
    { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
    { tag: [tags.tagName, tags.keyword], color: 'var(--code-keyword)' },
    { tag: [tags.punctuation, tags.bracket, tags.separator], color: 'var(--code-punct)' },
    { tag: [tags.comment, tags.meta], color: 'var(--code-gutter-active)' },
    { tag: tags.invalid, color: 'var(--content-error)' },
  ]),
)

/** A completion option that keeps the variable it offers, for rendering. */
interface VariableCompletion extends Completion {
  variable: Resolution
}

/** Offers the variables of `current()` after `{{`, filtered and ordered as in the text inputs. */
function variableSource(current: () => Resolution[] | null | undefined) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\{\{[\w.-]*$/)
    const options = current()
    if (!match || !options) return null
    const from = match.from + 2
    const matches = filterOptions(options, match.text.slice(2))
    if (matches.length === 0) return null
    return {
      from,
      filter: false,
      options: matches.map((variable): VariableCompletion => ({
        label: variable.name,
        variable,
        apply: (view, _completion, start, end) => {
          const doc = view.state.doc.toString()
          const done = insertCompletion(doc, start, end, variable.name)
          view.dispatch({
            changes: { from: start, to: end, insert: done.insert },
            selection: { anchor: done.caret },
            userEvent: 'input.complete',
          })
        },
      })),
    }
  }
}

function optionPart(className: string, text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = className
  span.textContent = text
  return span
}

/** The `{{` completion with the same option parts as the text inputs' menu; Tab accepts like Enter. */
function variableCompletion(current: () => Resolution[] | null | undefined): Extension {
  return [
    autocompletion({
      override: [variableSource(current)],
      icons: false,
      optionClass: () => 'var-option',
      tooltipClass: () => 'var-menu-cm',
      addToOptions: [
        {
          position: 60,
          render: (c) => optionPart('var-option-value', optionValue((c as VariableCompletion).variable)),
        },
        {
          position: 70,
          render: (c) => optionPart('var-option-source', SOURCE_LABELS[(c as VariableCompletion).variable.source]),
        },
      ],
    }),
    Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
  ]
}

/** Cmd/Ctrl+Enter is the "send" shortcut of the request editor, so the editor must not claim it. */
const keys = [...defaultKeymap.filter((binding) => binding.key !== 'Mod-Enter'), ...searchKeymap]

export function CodeEditor({
  value,
  language,
  onChange,
  readOnly = false,
  label,
  wrap = true,
  variables = false,
  completions,
  ref,
}: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const completionsRef = useRef(completions)
  completionsRef.current = completions
  const initial = useRef({ value, language, readOnly, label, wrap, variables })
  const languageSlot = useRef(new Compartment())
  const readOnlySlot = useRef(new Compartment())
  const labelSlot = useRef(new Compartment())
  const wrapSlot = useRef(new Compartment())
  onChangeRef.current = onChange

  useImperativeHandle(ref, () => ({
    openSearch() {
      const v = view.current
      if (v) openSearchPanel(v)
    },
  }))

  useEffect(() => {
    const start = initial.current
    const v = new EditorView({
      parent: host.current ?? undefined,
      state: EditorState.create({
        doc: start.value,
        extensions: [
          history(),
          keymap.of([...keys, ...historyKeymap]),
          wrapSlot.current.of(start.wrap ? EditorView.lineWrapping : []),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          search({ top: true }),
          highlightSelectionMatches(),
          theme,
          highlight,
          start.variables ? [variableMarks, variableCompletion(() => completionsRef.current)] : [],
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
    view.current?.dispatch({ effects: wrapSlot.current.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap])

  useEffect(() => {
    const attrs = EditorView.contentAttributes.of(label ? { 'aria-label': label } : {})
    view.current?.dispatch({ effects: labelSlot.current.reconfigure(attrs) })
  }, [label])

  return <div className="code-editor" ref={host} />
}
