const VARIABLE = /(\{\{[^{}]*\}\})/

/** Applies `fn` to the text between `{{variables}}`; the variables themselves are never touched. */
function mapOutsideVariables(text: string, fn: (part: string) => string): string {
  return text
    .split(VARIABLE)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('')
}

/** Percent-encodes a query key or value, leaving `{{variables}}` as they are. */
export function encode(text: string): string {
  return mapOutsideVariables(text, (part) => {
    try {
      return encodeURIComponent(part)
    } catch {
      return part // lone surrogate: nothing sensible to encode
    }
  })
}

/** Decodes a query key or value, leaving `{{variables}}` and text with malformed escapes as they are. */
export function decode(text: string): string {
  return mapOutsideVariables(text, (part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part // not a valid escape sequence: keep what the user typed
    }
  })
}
