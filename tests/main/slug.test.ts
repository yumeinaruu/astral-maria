import { describe, expect, it } from 'vitest'
import { slugify, uniqueSlug } from '../../src/main/storage/slug'

describe('slugify', () => {
  it('lowercases and dashes spaces', () => {
    expect(slugify('My Request')).toBe('my-request')
  })
  it('neutralizes path traversal', () => {
    expect(slugify('../../etc/passwd')).toBe('etc-passwd')
  })
  it('replaces separators', () => {
    expect(slugify('a/b\\c')).toBe('a-b-c')
  })
  it('falls back to untitled', () => {
    expect(slugify('')).toBe('untitled')
    expect(slugify('😀')).toBe('untitled')
  })
  it('keeps unicode letters', () => {
    expect(slugify('Привет мир')).toBe('привет-мир')
  })
  it('limits length to 80', () => {
    expect(slugify('a'.repeat(500)).length).toBeLessThanOrEqual(80)
  })
  it('suffixes Windows reserved names with a dash', () => {
    expect(slugify('CON')).toBe('con-')
    expect(slugify('nul')).toBe('nul-')
    expect(slugify('com1')).toBe('com1-')
  })
  it('NFC-normalizes', () => {
    const decomposed = 'Ünï'
    const result = slugify(decomposed)
    expect(result).toBe(result.normalize('NFC'))
    expect(result).toBe('ünï')
  })
})

describe('uniqueSlug', () => {
  it('returns base when free', () => {
    expect(uniqueSlug('a', new Set())).toBe('a')
  })
  it('appends counter', () => {
    expect(uniqueSlug('a', new Set(['a']))).toBe('a-2')
    expect(uniqueSlug('a', new Set(['a', 'a-2']))).toBe('a-3')
  })
  it('compares lowercase', () => {
    expect(uniqueSlug('a', new Set(['A']))).toBe('a-2')
    expect(uniqueSlug('A', new Set(['a']))).toBe('A-2')
  })
})
