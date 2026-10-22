import { describe, expect, it } from 'vitest'
import { MAX_DATA_ROWS, dataScope, parseDataFile } from '../../src/main/runner/dataFile'

describe('parseDataFile: CSV', () => {
  it('reads the header and keeps values as strings', () => {
    expect(parseDataFile('user,id\nann,7\nbob,8', 'csv')).toEqual([
      { user: 'ann', id: '7' },
      { user: 'bob', id: '8' },
    ])
  })

  it('reads quoted fields with commas, "" escapes and newlines', () => {
    const text = 'a,b,c\n"x, y","say ""hi""","line 1\nline 2"\n'
    expect(parseDataFile(text, 'csv')).toEqual([{ a: 'x, y', b: 'say "hi"', c: 'line 1\nline 2' }])
  })

  it('reads CRLF line ends, including inside quotes', () => {
    expect(parseDataFile('a,b\r\n1,2\r\n"3\r\n4",5\r\n', 'csv')).toEqual([
      { a: '1', b: '2' },
      { a: '3\r\n4', b: '5' },
    ])
  })

  it('strips a leading BOM and trims header names', () => {
    expect(parseDataFile('﻿ user , id \nann,7', 'csv')).toEqual([{ user: 'ann', id: '7' }])
  })

  it('ignores a trailing newline and skips empty lines', () => {
    expect(parseDataFile('a\n1\n\n\n2\n', 'csv')).toEqual([{ a: '1' }, { a: '2' }])
    expect(parseDataFile('a,b\n1,2\r\n\r\n3,4\r\n', 'csv')).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ])
  })

  it('keeps a row whose only field is quoted and empty', () => {
    expect(parseDataFile('a\n""\n1', 'csv')).toEqual([{ a: '' }, { a: '1' }])
  })

  it("gives '' to the columns a short row lacks", () => {
    expect(parseDataFile('a,b,c\n1\n1,2', 'csv')).toEqual([
      { a: '1', b: '', c: '' },
      { a: '1', b: '2', c: '' },
    ])
  })

  it('keeps empty values and spaces inside values', () => {
    expect(parseDataFile('a,b,c\n, x ,', 'csv')).toEqual([{ a: '', b: ' x ', c: '' }])
  })

  it('rejects a row longer than the header', () => {
    expect(() => parseDataFile('a,b\n1,2\n1,2,3', 'csv')).toThrow('Row 2 has 3 values but the header has 2')
  })

  it('rejects duplicate header names, after trimming', () => {
    expect(() => parseDataFile('a,b, a\n1,2,3', 'csv')).toThrow('Duplicate column "a"')
  })

  it('treats a header named __proto__ as a plain column', () => {
    const [row] = parseDataFile('__proto__,b\n1,2', 'csv')
    expect(Object.keys(row)).toEqual(['__proto__', 'b'])
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(row, '__proto__')?.value).toBe('1')
  })

  it.each([
    ['an empty file', ''],
    ['only a BOM and blank lines', '﻿\n\r\n'],
    ['only a header', 'a,b\n'],
  ])('rejects %s', (_, text) => {
    expect(() => parseDataFile(text, 'csv')).toThrow('The data file has no rows')
  })

  it('rejects more than the row limit', () => {
    const ok = 'a\n' + '1\n'.repeat(MAX_DATA_ROWS)
    expect(parseDataFile(ok, 'csv')).toHaveLength(MAX_DATA_ROWS)
    expect(() => parseDataFile(ok + '1\n', 'csv')).toThrow('The data file has more than 10000 rows')
  })

  it('rejects an unterminated quote', () => {
    expect(() => parseDataFile('a\n"open', 'csv')).toThrow(/quote/)
  })
})

describe('parseDataFile: JSON', () => {
  it('keeps values as they are', () => {
    const rows = [{ user: 'ann', id: 7, ok: true, tags: ['a'], meta: { x: null } }, {}]
    expect(parseDataFile(JSON.stringify(rows), 'json')).toEqual(rows)
  })

  it('strips a leading BOM', () => {
    expect(parseDataFile('﻿[{"a":1}]', 'json')).toEqual([{ a: 1 }])
  })

  it.each([
    ['an object', '{"a":1}'],
    ['an array of numbers', '[1,2]'],
    ['an array holding an array', '[[1]]'],
    ['an array holding null', '[{"a":1},null]'],
    ['a string', '"x"'],
  ])('rejects %s', (_, text) => {
    expect(() => parseDataFile(text, 'json')).toThrow('The data file must be a JSON array of objects')
  })

  it('rejects text that is not JSON', () => {
    expect(() => parseDataFile('[{a:1}]', 'json')).toThrow(/^The data file is not valid JSON/)
  })

  it('rejects an empty array or an empty file', () => {
    expect(() => parseDataFile('[]', 'json')).toThrow('The data file has no rows')
    expect(() => parseDataFile('  \n', 'json')).toThrow('The data file has no rows')
  })

  it('rejects more than the row limit', () => {
    const rows = (n: number) => JSON.stringify(Array.from({ length: n }, () => ({})))
    expect(parseDataFile(rows(MAX_DATA_ROWS), 'json')).toHaveLength(MAX_DATA_ROWS)
    expect(() => parseDataFile(rows(MAX_DATA_ROWS + 1), 'json')).toThrow('The data file has more than 10000 rows')
  })
})

describe('dataScope', () => {
  it('converts values like pm.environment.set', () => {
    expect(
      dataScope({ s: 'text', n: 5, b: false, nl: null, u: undefined, o: { a: 1 }, arr: [1, 'x'] }),
    ).toEqual({ s: 'text', n: '5', b: 'false', nl: '', u: '', o: '{"a":1}', arr: '[1,"x"]' })
  })

  it('keeps a key named __proto__ as data', () => {
    const scope = dataScope(JSON.parse('{"__proto__":{"a":1}}'))
    expect(Object.hasOwn(scope, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(scope, '__proto__')?.value).toBe('{"a":1}')
  })
})
