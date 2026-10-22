// The runner's data files: a CSV or JSON file whose rows feed the iterations, one row per iteration. Parsing
// errors are thrown as Errors whose messages are shown to the user as they are.

/** One row: CSV values are strings, JSON values are kept as they are in the file. */
export type DataRow = Record<string, unknown>

/** The largest data file the runner reads; the caller checks it before reading. */
export const MAX_DATA_BYTES = 10 * 1024 * 1024
export const MAX_DATA_ROWS = 10_000

const BOM = '﻿'

/** Sets a key on a plain object even when it is `__proto__`. */
function put(object: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, writable: true, configurable: true, enumerable: true })
}

/** Parses a data file; `kind` comes from the file extension (.csv / .json). */
export function parseDataFile(text: string, kind: 'csv' | 'json'): DataRow[] {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text
  const rows = kind === 'csv' ? parseCsv(body) : parseJson(body)
  if (rows.length === 0) throw new Error('The data file has no rows')
  if (rows.length > MAX_DATA_ROWS) throw new Error(`The data file has more than ${MAX_DATA_ROWS} rows`)
  return rows
}

function parseJson(text: string): DataRow[] {
  if (text.trim() === '') return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    throw new Error(`The data file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  const isRow = (row: unknown) => typeof row === 'object' && row !== null && !Array.isArray(row)
  if (!Array.isArray(value) || !value.every(isRow)) {
    throw new Error('The data file must be a JSON array of objects')
  }
  return value as DataRow[]
}

/**
 * RFC 4180 records. A record that is a single unquoted empty field is an empty line and is dropped. Text after a
 * closing quote is kept as part of the field rather than rejected.
 */
function csvRecords(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quotedInRecord = false
  let i = 0

  const endRecord = () => {
    record.push(field)
    if (record.length > 1 || record[0] !== '' || quotedInRecord) records.push(record)
    record = []
    field = ''
    quotedInRecord = false
  }

  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' && field === '') {
      quotedInRecord = true
      i++
      for (;;) {
        if (i >= text.length) throw new Error('The data file has a quote that is never closed')
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          i++
          break
        }
        field += text[i++]
      }
    } else if (ch === ',') {
      record.push(field)
      field = ''
      i++
    } else if (ch === '\r' && text[i + 1] === '\n') {
      endRecord()
      i += 2
    } else if (ch === '\n' || ch === '\r') {
      endRecord()
      i++
    } else {
      field += ch
      i++
    }
  }
  if (field !== '' || record.length > 0 || quotedInRecord) endRecord()
  return records
}

function parseCsv(text: string): DataRow[] {
  const [header, ...records] = csvRecords(text)
  if (header === undefined) return []
  const names = header.map((name) => name.trim())
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate column "${name}"`)
    seen.add(name)
  }
  return records.map((values, index) => {
    if (values.length > names.length) {
      throw new Error(`Row ${index + 1} has ${values.length} values but the header has ${names.length}`)
    }
    const row: DataRow = {}
    names.forEach((name, column) => put(row, name, values[column] ?? ''))
    return row
  })
}

/** A variable value as `pm.environment.set` would store it. */
function toValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value) ?? String(value)
  return String(value)
}

/** The row as a variable scope: every value converted to a string. */
export function dataScope(row: DataRow): Record<string, string> {
  const scope: Record<string, string> = {}
  for (const key of Object.keys(row)) put(scope, key, toValue(row[key]))
  return scope
}
