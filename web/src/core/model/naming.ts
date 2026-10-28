// Adapted from Api2Class (web/src/core/naming.ts): both tools split and convert names the same way.

export type NamingConvention = 'PascalCase' | 'camelCase' | 'snake_case' | 'SCREAMING_SNAKE_CASE'

/** Splits a name into words: `postal_code`, `postalCode`, `PostalCode`, `postal-code` and `Postal Code`
 * all give ["postal", "code"]. Accents are removed (`teléfono` → telefono) and digits stay with the
 * word before them (`address2`). */
export function splitWords(text: string): string[] {
  const cached = splitCache.get(text)
  if (cached) return [...cached]
  const words = split(text)
  // The matching engine splits the same names many times: they are worked out once
  if (splitCache.size > 20000) splitCache.clear()
  splitCache.set(text, words)
  return [...words]
}

const splitCache = new Map<string, string[]>()

function split(text: string): string[] {
  const plain = text.normalize('NFD').replace(/\p{M}/gu, '')
  return plain
    .split(/[^\p{L}\p{N}]+/u)
    .flatMap((part) =>
      part
        // userId → user Id; HTTPServer → HTTP Server
        .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
        .split(' '),
    )
    .filter((word) => word !== '')
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

export function toPascalCase(text: string): string {
  return splitWords(text).map(capitalize).join('')
}

export function toCamelCase(text: string): string {
  const pascal = toPascalCase(text)
  const first = splitWords(text)[0] ?? ''
  return first.toLowerCase() + pascal.slice(first.length)
}

export function toSnakeCase(text: string): string {
  return splitWords(text)
    .map((word) => word.toLowerCase())
    .join('_')
}

export function toScreamingSnakeCase(text: string): string {
  return toSnakeCase(text).toUpperCase()
}

export function convertCase(text: string, convention: NamingConvention): string {
  if (convention === 'PascalCase') return toPascalCase(text)
  if (convention === 'camelCase') return toCamelCase(text)
  if (convention === 'SCREAMING_SNAKE_CASE') return toScreamingSnakeCase(text)
  return toSnakeCase(text)
}

/** Lowercase words of a name, for comparing names written in different conventions:
 * `userId`, `user_id`, `UserID` and `user-id` all give ["user", "id"]. */
export function nameWords(text: string): string[] {
  return splitWords(text).map((word) => word.toLowerCase())
}

// Already singular, or the same in singular and plural
const UNCHANGED = new Set(['data', 'metadata', 'news', 'series', 'species', 'info', 'information', 'media', 'status'])
const IRREGULAR: Record<string, string> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  // -ies plurals of words ending in -ie
  movies: 'movie',
  cookies: 'cookie',
}

/** English singular of one word, keeping its case: `Categories` → `Category`, `addresses` → `address`.
 * Returns the word unchanged when it does not look like a plural. */
export function singularize(word: string): string {
  const lower = word.toLowerCase()
  if (UNCHANGED.has(lower)) return word
  if (lower in IRREGULAR) return word.slice(0, 1) + IRREGULAR[lower].slice(1)
  if (/[^aeiou]ies$/.test(lower)) return word.slice(0, -3) + (word.endsWith('IES') ? 'Y' : 'y')
  if (/(ss|us|x|z|ch|sh)es$/.test(lower)) return word.slice(0, -2)
  if (/(ss|us|is)$/.test(lower) || !lower.endsWith('s') || lower.length < 3) return word
  return word.slice(0, -1)
}

/** Makes a name usable as an identifier: never empty, not starting with a digit and not a reserved word. */
export function safeIdentifier(name: string, reserved: ReadonlySet<string>, fallback: string): string {
  if (name === '') return fallback
  if (/^\p{N}/u.test(name)) return `_${name}`
  if (reserved.has(name)) return `${name}_`
  return name
}

/** Returns `name`, or `name2`, `name3`... if it is already taken, and marks the result as taken. */
export function uniqueName(name: string, used: Set<string>): string {
  let result = name
  for (let n = 2; used.has(result); n++) result = `${name}${n}`
  used.add(result)
  return result
}
