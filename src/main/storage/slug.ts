const MAX_LENGTH = 80
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/

export function slugify(name: string): string {
  let slug = name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, '')
  if (slug === '') return 'untitled'
  if (RESERVED.test(slug)) slug += '-'
  return slug
}

export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  const lowered = new Set([...taken].map((t) => t.toLowerCase()))
  if (!lowered.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!lowered.has(candidate.toLowerCase())) return candidate
  }
}
