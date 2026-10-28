import type { Annotation } from '../../model/schema.ts'
import type { Cursor } from './lexer.ts'
import type { RawField, RawType } from './raw.ts'

/** Reads `@Name`, `@pkg.Name(args)` at the cursor (Java, Kotlin, Dart, TypeScript and Python decorators). */
export function readAtAnnotation(cursor: Cursor, source: string): Annotation | null {
  if (!cursor.is('@') || !cursor.isIdent(1)) return null
  cursor.next()
  let name = cursor.next().value
  while (cursor.is('.') && cursor.isIdent(1)) {
    cursor.next()
    name += `.${cursor.next().value}`
  }
  // Kotlin use-site targets: @field:Json(...), @get:JsonProperty
  if (cursor.is(':') && cursor.isIdent(1) && ['field', 'get', 'set', 'param', 'property'].includes(name)) {
    cursor.next()
    return readNamedAnnotation(cursor, source, cursor.next().value)
  }
  return readNamedAnnotation(cursor, source, name)
}

function readNamedAnnotation(cursor: Cursor, source: string, name: string): Annotation {
  if (!cursor.is('(')) return { name }
  const start = cursor.index
  cursor.skipGroup()
  const text = cursor.textBetween(source, start, cursor.index)
  return { name, args: text.slice(1, -1).trim() }
}

/** Reads a bracketed attribute list: C# `[Required, Column("x")]`, Rust and PHP `#[serde(rename = "x")]`.
 * The cursor must be on `[` or `#[`. Returns one annotation per comma-separated entry. */
export function readBracketAttributes(cursor: Cursor, source: string): Annotation[] {
  const start = cursor.index
  cursor.skipGroup()
  const end = cursor.index
  const annotations: Annotation[] = []
  // Inner tokens, without the brackets
  let index = start + 1
  while (index < end - 1) {
    const token = cursor.tokens[index]
    if (token.kind !== 'ident') {
      index++
      continue
    }
    let name = token.value
    index++
    while (index < end - 1 && ['.', '::', '\\'].includes(cursor.tokens[index].value) && cursor.tokens[index + 1]?.kind === 'ident') {
      name += `${cursor.tokens[index].value}${cursor.tokens[index + 1].value}`
      index += 2
    }
    // C# attribute targets: [property: JsonPropertyName("x")]
    if (cursor.tokens[index]?.value === ':' && ['property', 'field', 'param', 'return'].includes(name)) {
      index++
      continue
    }
    const annotation: Annotation = { name }
    if (cursor.tokens[index]?.value === '(') {
      let depth = 0
      const from = index
      for (; index < end; index++) {
        const value = cursor.tokens[index].value
        if (cursor.tokens[index].kind === 'string') continue
        if (value === '(' || value === '[' || value === '{') depth++
        else if (value === ')' || value === ']' || value === '}') {
          depth--
          if (depth === 0) break
        }
      }
      annotation.args = source.slice(cursor.tokens[from].end, cursor.tokens[index].start).trim()
      index++
    }
    annotations.push(annotation)
    // Skip to the next entry
    while (index < end - 1 && cursor.tokens[index].value !== ',') index++
    index++
  }
  return annotations
}

/** Value of a named argument (`name = "x"`, `name: 'x'`, `nullable = false`) or, with `positional`,
 * the first string argument (`@JsonProperty("x")`). */
export function annotationArg(annotation: Annotation | undefined, name: string | null): string | undefined {
  if (!annotation?.args) return undefined
  if (name === null) {
    const match = /^\s*(?:value\s*=\s*)?(?:[rR]|@)?(["'`])((?:\\.|(?!\1).)*)\1/.exec(annotation.args)
    return match?.[2]
  }
  const pattern = new RegExp(`(?:^|[\\s,({])${name}\\s*[:=]\\s*(?:(["'\`])((?:\\\\.|(?!\\1).)*)\\1|([\\w.\\-]+))`)
  const match = pattern.exec(annotation.args)
  if (!match) return undefined
  return match[2] ?? match[3]
}

const simple = (name: string) =>
  name
    .split(/\.|::|\\/)
    .pop()!
    .toLowerCase()

// Names whose first string argument is the name on the wire
const SERIALIZED_NAME = new Set([
  'jsonproperty',
  'serializedname',
  'jsonpropertyname',
  'jsonkey',
  'json',
  'serialname',
  'jsonfield',
  'expose',
  'jsonname',
])
const NOT_NULL = new Set(['notnull', 'nonnull', 'notblank', 'notempty', 'required', 'isnotempty', 'isdefined'])
const NULLABLE = new Set(['nullable', 'isoptional', 'optional'])
// Values the database or framework fills in: never needed from a mapping
const GENERATED = new Set([
  'generatedvalue',
  'primarygeneratedcolumn',
  'createdatecolumn',
  'updatedatecolumn',
  'deletedatecolumn',
  'versioncolumn',
  'createddate',
  'lastmodifieddate',
  'creationtimestamp',
  'updatetimestamp',
  'databasegenerated',
  'version',
])
const IGNORED = new Set(['transient', 'jsonignore', 'notmapped', 'exclude'])

/** Applies what well-known annotations say about a field: its name on the wire or in the database,
 * whether it can be null, and whether it is generated. Returns false when the field is not part of the
 * data (`@Transient`, `[NotMapped]`) and should be dropped. */
export function applyAnnotations(field: RawField, annotations: Annotation[]): boolean {
  if (annotations.length === 0) return true
  field.annotations = [...(field.annotations ?? []), ...annotations]
  for (const annotation of annotations) {
    const name = simple(annotation.name)
    if (IGNORED.has(name)) return false
    if (SERIALIZED_NAME.has(name)) {
      const wire = annotationArg(annotation, null) ?? annotationArg(annotation, 'name') ?? annotationArg(annotation, 'value')
      if (wire) field.serializedName = wire
    }
    if (name === 'jsonalias') {
      const aliases = [...(annotation.args ?? '').matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
      if (aliases.length > 0) field.aliases = aliases
    }
    if (NOT_NULL.has(name)) {
      field.nullable = false
      if (field.type?.nullable) field.type = { ...field.type, nullable: false }
    }
    if (NULLABLE.has(name)) {
      field.nullable = true
      if (name !== 'nullable') field.optional = true
    }
    if (GENERATED.has(name)) field.generated = true
    if (name === 'column' || name === 'joincolumn' || name === 'field') {
      const column = annotationArg(annotation, 'name') ?? (name === 'column' ? annotationArg(annotation, null) : undefined)
      if (column) field.serializedName = column
      const nullable = annotationArg(annotation, 'nullable') ?? annotationArg(annotation, 'null')
      if (nullable === 'false' || nullable === 'False') {
        field.nullable = false
        if (field.type?.nullable) field.type = { ...field.type, nullable: false }
      }
      if (nullable === 'true' || nullable === 'True') field.nullable = true
      const alias = annotationArg(annotation, 'alias')
      if (alias) field.serializedName = alias
    }
    if (name === 'id' && annotations.some((item) => GENERATED.has(simple(item.name)))) field.generated = true
  }
  return true
}

/** The name of a raw type without generics, for checks like "is this a list?" */
export function rawName(type: RawType | null): string {
  return type ? (type.name.split(/\.|::|\\/).pop() ?? type.name) : ''
}
