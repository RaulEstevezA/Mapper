import type { Cursor } from './lexer.ts'
import type { RawType } from './raw.ts'

/** How a language writes types. Every option is off by default. */
export interface TypeSyntax {
  /** Brackets of generic arguments: `List<String>` or `list[str]` */
  generics: '<>' | '[]'
  /** `String[]`, `int[][]` */
  arraySuffix?: boolean
  /** `String?`, and Swift's `String!` */
  nullableSuffix?: boolean
  /** `?string` (PHP) */
  nullablePrefix?: boolean
  /** `string | null`, `A | B` */
  unions?: boolean
  /** `*User` (Go): a pointer may be nil */
  pointers?: boolean
  /** `[String]` and `[String: Int]` (Swift) */
  bracketCollections?: boolean
  /** `[]string` and `map[string]int` (Go) */
  goCollections?: boolean
  /** Reference and lifetime markers to skip (`&'a str` in Rust) */
  references?: boolean
  /** Qualified names joined by these separators: `java.util.List`, `App\\Models\\User`, `std::vec::Vec` */
  separators?: readonly string[]
  /** Reads a type the common syntax does not know (TypeScript object literal types); null to fall through */
  custom?: (cursor: Cursor) => RawType | null
  /** `A & B` (TypeScript): read as a union-like `&` node */
  intersections?: boolean
}

const DEFAULT_SEPARATORS = ['.']

function readName(cursor: Cursor, syntax: TypeSyntax): string | null {
  const separators = syntax.separators ?? DEFAULT_SEPARATORS
  let name = ''
  // A leading separator: `\DateTime` in PHP, `::std::string`
  for (const separator of separators) {
    if (cursor.is(separator) && separator !== '.') {
      cursor.next()
      name = separator
    }
  }
  if (!cursor.isIdent()) return name === '' ? null : name
  name += cursor.next().value
  for (;;) {
    const separator = separators.find((item) => cursor.is(item))
    if (separator && cursor.isIdent(1)) {
      cursor.next()
      name += separator + cursor.next().value
      continue
    }
    return name
  }
}

function readArguments(cursor: Cursor, syntax: TypeSyntax, close: string): RawType[] {
  const args: RawType[] = []
  while (!cursor.done && !cursor.is(close)) {
    const arg = readType(cursor, syntax)
    if (arg) args.push(arg)
    else if (!cursor.is(close) && !cursor.is(',')) cursor.next()
    if (!cursor.eat(',')) break
  }
  // `>>` is read as two `>` tokens by the lexer, so a simple match is enough
  cursor.eat(close)
  return args
}

function readSingle(cursor: Cursor, syntax: TypeSyntax): RawType | null {
  if (syntax.references) {
    while (cursor.is('&') || cursor.is('mut') || cursor.is('dyn') || cursor.is('impl') || (cursor.is("'") && cursor.isIdent(1))) {
      if (cursor.is("'")) cursor.next()
      cursor.next()
    }
  }

  let nullable = false
  if (syntax.nullablePrefix && cursor.eat('?')) nullable = true
  if (syntax.pointers) {
    while (cursor.eat('*')) nullable = true
  }

  let type: RawType | null = null
  if (syntax.goCollections && cursor.is('[')) {
    // []T, or [N]T for a fixed-size array
    cursor.next()
    while (!cursor.done && !cursor.is(']')) cursor.next()
    cursor.eat(']')
    const items = readSingle(cursor, syntax)
    type = { name: '[]', args: items ? [items] : [] }
  } else if (syntax.goCollections && cursor.is('map') && cursor.is('[', 1)) {
    cursor.next()
    cursor.next()
    const key = readType(cursor, syntax)
    cursor.eat(']')
    const value = readSingle(cursor, syntax)
    type = { name: '{}', args: [key ?? { name: 'string', args: [] }, value ?? { name: 'any', args: [] }] }
  } else if (syntax.bracketCollections && cursor.is('[')) {
    cursor.next()
    const first = readType(cursor, syntax)
    if (cursor.eat(':')) {
      const value = readType(cursor, syntax)
      cursor.eat(']')
      type = { name: '{}', args: [first ?? { name: 'Any', args: [] }, value ?? { name: 'Any', args: [] }] }
    } else {
      cursor.eat(']')
      type = { name: '[]', args: first ? [first] : [] }
    }
  } else if (syntax.custom && (type = syntax.custom(cursor))) {
    // Read by the language itself
  } else if (cursor.is('(')) {
    // A parenthesized type (`(string | null)[]`); tuples and function types are of unknown shape
    const start = cursor.index
    cursor.next()
    const inner = readType(cursor, syntax)
    if (inner && cursor.eat(')') && !cursor.is('=>') && !cursor.is('->')) type = inner
    else {
      cursor.index = start
      cursor.skipGroup()
      if (cursor.eat('=>') || cursor.eat('->')) readType(cursor, syntax)
      type = { name: 'any', args: [] }
    }
  } else if (cursor.peek()?.kind === 'string' || cursor.peek()?.kind === 'number') {
    // Literal types (`'active' | 'inactive'`), turned into enums by the parsers that support them
    const token = cursor.next()
    type = { name: token.kind === 'string' ? JSON.stringify(token.value) : token.value, args: [] }
  } else {
    const name = readName(cursor, syntax)
    if (name === null) return null
    const open = syntax.generics === '<>' ? '<' : '['
    const close = syntax.generics === '<>' ? '>' : ']'
    const args =
      cursor.is(open) && !(syntax.arraySuffix && open === '[' && cursor.is(']', 1))
        ? (cursor.next(), readArguments(cursor, syntax, close))
        : []
    type = { name, args }
  }

  for (;;) {
    if (syntax.arraySuffix && cursor.is('[') && cursor.is(']', 1)) {
      cursor.next()
      cursor.next()
      type = { name: '[]', args: [type] }
      continue
    }
    if (syntax.nullableSuffix && (cursor.is('?') || cursor.is('!'))) {
      // `!` is Swift's implicitly unwrapped optional, but not Kotlin's `!!` operator
      cursor.next()
      type = { ...type, nullable: true }
      continue
    }
    break
  }
  if (nullable) type = { ...type, nullable: true }
  return type
}

/** Reads a type at the cursor, or returns null (and moves nothing) when there is none. */
export function readType(cursor: Cursor, syntax: TypeSyntax): RawType | null {
  // A leading `|` or `&` is allowed in TypeScript (`type A =\n  | 'x'\n  | 'y'`)
  if (syntax.unions && (cursor.is('|') || (syntax.intersections && cursor.is('&')))) cursor.next()
  const first = readIntersection(cursor, syntax)
  if (!first || !syntax.unions || !cursor.is('|')) return first
  const options = [first]
  while (cursor.eat('|')) {
    const option = readIntersection(cursor, syntax)
    if (option) options.push(option)
  }
  return { name: '|', args: options }
}

function readIntersection(cursor: Cursor, syntax: TypeSyntax): RawType | null {
  const first = readSingle(cursor, syntax)
  if (!first || !syntax.intersections || !cursor.is('&')) return first
  const parts = [first]
  while (cursor.eat('&')) {
    const part = readSingle(cursor, syntax)
    if (part) parts.push(part)
  }
  return { name: '&', args: parts }
}
