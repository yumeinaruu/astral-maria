import { MASK, type Resolution } from './variables'

/** The text before the caret that opens the variable completion: `{{` and a partly typed name. */
export const COMPLETION_TRIGGER = /\{\{([\w.-]*)$/

/** At most this many options are offered. */
export const MAX_OPTIONS = 50

export interface CompletionQuery {
  /** Where the typed name starts (just after `{{`); the insertion replaces from here to the caret. */
  from: number
  prefix: string
}

/** The completion query at `caret` in `text`, or null when the caret is not after `{{` and a partial name. */
export function completionAt(text: string, caret: number): CompletionQuery | null {
  const match = COMPLETION_TRIGGER.exec(text.slice(0, caret))
  if (!match) return null
  return { from: caret - match[1].length, prefix: match[1] }
}

/** The options for `prefix`: names starting with it first, then names containing it (both ignoring case), capped. */
export function filterOptions(options: Resolution[], prefix: string): Resolution[] {
  const needle = prefix.toLowerCase()
  const starts: Resolution[] = []
  const contains: Resolution[] = []
  for (const option of options) {
    const name = option.name.toLowerCase()
    if (name.startsWith(needle)) starts.push(option)
    else if (name.includes(needle)) contains.push(option)
  }
  return [...starts, ...contains].slice(0, MAX_OPTIONS)
}

/**
 * The text after picking `name` for the query starting at `from`: the typed prefix (up to `caret`) becomes `name}}`,
 * without a second `}}` when one already follows the caret. The caret goes after the closing braces.
 */
export function insertCompletion(
  text: string,
  from: number,
  caret: number,
  name: string,
): { text: string; caret: number; insert: string } {
  const after = text.slice(caret)
  const insert = after.startsWith('}}') ? name : `${name}}}`
  return { text: text.slice(0, from) + insert + after, caret: from + name.length + 2, insert }
}

/** The value an option shows: secrets masked. */
export function optionValue(option: Resolution): string {
  return option.secret ? MASK : option.value
}
