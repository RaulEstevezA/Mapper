import { convertCase } from '../../model/naming.ts'
import { primitive, type Annotation } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { annotationArg, readBracketAttributes } from './annotations.ts'
import { Cursor, LexError, tokenize, type LexerConfig, type Token } from './lexer.ts'
import { buildSchema, type RawDeclarations, type RawEnum, type RawField, type RawModel, type RawType, type TypeTable } from './raw.ts'
import { readType, type TypeSyntax } from './typeSyntax.ts'

const LEXER: LexerConfig = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  nestedComments: true,
  strings: [{ open: '"', close: '"', escapes: true, multiline: true }],
  stringPrefixes: /^b/,
  rawHashStrings: true,
}

const SYNTAX: TypeSyntax = { generics: '<>', references: true, separators: ['::'] }

export const RUST_TYPES: TypeTable = {
  primitives: {
    String: primitive('string'),
    str: primitive('string'),
    char: primitive('string'),
    i8: primitive('integer', 8),
    i16: primitive('integer', 16),
    i32: primitive('integer', 32),
    i64: primitive('integer', 64),
    i128: primitive('integer'),
    isize: primitive('integer', 64),
    u8: primitive('integer', 8),
    u16: primitive('integer', 16),
    u32: primitive('integer', 32),
    u64: primitive('integer', 64),
    u128: primitive('integer'),
    usize: primitive('integer', 64),
    f32: primitive('float', 32),
    f64: primitive('float', 64),
    Decimal: primitive('decimal'),
    bool: primitive('boolean'),
    DateTime: primitive('datetime'),
    NaiveDateTime: primitive('datetime'),
    OffsetDateTime: primitive('datetime'),
    PrimitiveDateTime: primitive('datetime'),
    SystemTime: primitive('datetime'),
    NaiveDate: primitive('date'),
    Date: primitive('date'),
    NaiveTime: primitive('time'),
    Time: primitive('time'),
    Duration: primitive('duration'),
    Uuid: primitive('uuid'),
    'Vec<u8>': primitive('binary'),
    Bytes: primitive('binary'),
    Value: primitive('any'),
  },
  lists: ['Vec', 'VecDeque', 'HashSet', 'BTreeSet', 'IndexSet', 'LinkedList'],
  maps: ['HashMap', 'BTreeMap', 'IndexMap'],
  optionals: ['Option'],
  transparent: ['Box', 'Rc', 'Arc', 'Cow', 'RefCell', 'Cell'],
}

/** serde's rename_all conventions. */
function renameAll(name: string, rule: string): string {
  switch (rule) {
    case 'camelCase':
      return convertCase(name, 'camelCase')
    case 'PascalCase':
      return convertCase(name, 'PascalCase')
    case 'snake_case':
      return convertCase(name, 'snake_case')
    case 'SCREAMING_SNAKE_CASE':
      return convertCase(name, 'SCREAMING_SNAKE_CASE')
    case 'kebab-case':
      return convertCase(name, 'snake_case').replace(/_/g, '-')
    case 'SCREAMING-KEBAB-CASE':
      return convertCase(name, 'SCREAMING_SNAKE_CASE').replace(/_/g, '-')
    case 'lowercase':
      return name.toLowerCase()
    case 'UPPERCASE':
      return name.toUpperCase()
    default:
      return name
  }
}

function serdeArgs(attributes: Annotation[]): Annotation[] {
  return attributes.filter((item) => item.name === 'serde')
}

function serdeFlag(attributes: Annotation[], flag: string): boolean {
  return serdeArgs(attributes).some((item) => new RegExp(`(^|[\\s,])${flag}(\\s*[,=]|\\s*$)`).test(item.args ?? ''))
}

function serdeValue(attributes: Annotation[], key: string): string | undefined {
  for (const item of serdeArgs(attributes)) {
    const value = annotationArg(item, key)
    if (value !== undefined) return value
  }
  return undefined
}

function normalize(type: RawType | null): RawType | null {
  if (!type) return null
  if (type.name.split('::').pop() === 'Vec' && type.args[0]?.name === 'u8') return { name: 'Vec<u8>', args: [] }
  return { ...type, args: type.args.map((arg) => normalize(arg)!).filter(Boolean) }
}

class Reader {
  readonly cursor: Cursor
  readonly source: string
  readonly declarations: RawDeclarations = { models: [], enums: [], aliases: new Map(), warnings: [] }

  constructor(source: string, tokens: Token[]) {
    this.source = source
    this.cursor = new Cursor(tokens)
  }

  run() {
    const { cursor } = this
    let attributes: Annotation[] = []
    // Documentation written above the attributes belongs to the declaration
    let attributesDoc: string | undefined
    while (!cursor.done) {
      if (cursor.is('#[') || (cursor.is('#') && cursor.is('[', 1))) {
        if (attributes.length === 0) attributesDoc = cursor.peek()?.doc
        if (cursor.is('#')) cursor.next()
        attributes.push(...readBracketAttributes(cursor, this.source))
        continue
      }
      if (cursor.is('#') && cursor.is('!', 1)) {
        // Inner attribute: #![allow(...)]
        cursor.next()
        cursor.next()
        cursor.skipGroup()
        continue
      }
      const doc = cursor.peek()?.doc ?? (attributes.length > 0 ? attributesDoc : undefined)
      if (cursor.is('pub')) {
        cursor.next()
        if (cursor.is('(')) cursor.skipGroup()
      }
      if (cursor.is('struct') && cursor.isIdent(1)) {
        cursor.next()
        this.structDeclaration(attributes, doc)
      } else if (cursor.is('enum') && cursor.isIdent(1)) {
        cursor.next()
        this.enumDeclaration(attributes, doc)
      } else if (cursor.is('type') && cursor.isIdent(1) && cursor.is('=', 2)) {
        cursor.next()
        const name = cursor.next().value
        cursor.next()
        const type = normalize(readType(cursor, SYNTAX))
        if (type) this.declarations.aliases!.set(name, type)
      } else if (cursor.is('impl') || cursor.is('fn') || cursor.is('mod') || cursor.is('trait')) {
        while (!cursor.done && !cursor.is('{') && !cursor.is(';')) cursor.next()
        if (cursor.is('{')) cursor.skipGroup()
        else cursor.next()
      } else if (cursor.is('{') || cursor.is('(')) cursor.skipGroup()
      else cursor.next()
      attributes = []
    }
  }

  private generics(): string[] {
    const { cursor } = this
    const names: string[] = []
    if (!cursor.is('<')) return names
    let depth = 0
    do {
      const token = cursor.next()
      if (token.value === '<') depth++
      else if (token.value === '>') depth--
      else if (depth === 1 && token.kind === 'ident' && ['<', ','].includes(cursor.tokens[cursor.index - 2]?.value)) names.push(token.value)
    } while (!cursor.done && depth > 0)
    return names
  }

  private structDeclaration(attributes: Annotation[], doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const model: RawModel = { name, kind: 'struct', fields: [], generics: this.generics(), construction: 'named' }
    if (doc) model.description = doc
    if (attributes.length > 0) model.annotations = attributes
    if (attributes.some((item) => item.name === 'derive' && /\b(Serialize|Deserialize)\b/.test(item.args ?? ''))) model.framework = 'serde'
    if (attributes.some((item) => item.name === 'derive' && /\b(Queryable|Insertable|FromRow|DeriveEntityModel)\b/.test(item.args ?? '')))
      model.kind = 'entity'
    // Tuple structs and unit structs have no named fields
    while (!cursor.done && !cursor.is('{') && !cursor.is('(') && !cursor.is(';')) cursor.next()
    if (!cursor.is('{')) {
      if (cursor.is('(')) cursor.skipGroup()
      return
    }
    const rule = serdeValue(attributes, 'rename_all')
    const structDefault = serdeFlag(attributes, 'default')
    this.declarations.models.push(model)
    cursor.next()
    while (!cursor.done && !cursor.is('}')) {
      const fieldDoc = cursor.peek()?.doc
      const fieldAttributes: Annotation[] = []
      while (cursor.is('#[') || (cursor.is('#') && cursor.is('[', 1))) {
        if (cursor.is('#')) cursor.next()
        fieldAttributes.push(...readBracketAttributes(cursor, this.source))
      }
      if (cursor.eat('pub') && cursor.is('(')) cursor.skipGroup()
      if (!cursor.isIdent()) {
        cursor.skipUntil([','])
        cursor.eat(',')
        continue
      }
      const fieldName = cursor.next().value.replace(/^r#/, '')
      cursor.eat(':')
      const typeStart = cursor.index
      const type = normalize(readType(cursor, SYNTAX))
      const field: RawField = { name: fieldName, type, typeText: cursor.textBetween(this.source, typeStart, cursor.index) }
      cursor.skipUntil([','])
      cursor.eat(',')
      if (fieldDoc) field.description = fieldDoc
      if (fieldAttributes.length > 0) field.annotations = fieldAttributes
      if (serdeFlag(fieldAttributes, 'skip') || serdeFlag(fieldAttributes, 'flatten')) continue
      const rename = serdeValue(fieldAttributes, 'rename') ?? (rule ? renameAll(fieldName, rule) : undefined)
      if (rename && rename !== fieldName) field.serializedName = rename
      const alias = serdeValue(fieldAttributes, 'alias')
      if (alias) field.aliases = [alias]
      if (structDefault || serdeFlag(fieldAttributes, 'default')) field.optional = true
      // serde accepts a missing Option field as None
      if (type?.name.split('::').pop() === 'Option') field.optional = true
      model.fields.push(field)
    }
    cursor.eat('}')
  }

  private enumDeclaration(attributes: Annotation[], doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    this.generics()
    const enumDef: RawEnum = { name, values: [] }
    if (doc) enumDef.description = doc
    while (!cursor.done && !cursor.is('{')) cursor.next()
    if (!cursor.eat('{')) return
    const rule = serdeValue(attributes, 'rename_all')
    let next = 0
    while (!cursor.done && !cursor.is('}')) {
      const variantAttributes: Annotation[] = []
      while (cursor.is('#[') || (cursor.is('#') && cursor.is('[', 1))) {
        if (cursor.is('#')) cursor.next()
        variantAttributes.push(...readBracketAttributes(cursor, this.source))
      }
      if (!cursor.isIdent()) {
        cursor.next()
        continue
      }
      const value: RawEnum['values'][number] = { name: cursor.next().value }
      // Variants with data (`Card { last4: String }`) keep only their name
      if (cursor.is('(') || cursor.is('{')) cursor.skipGroup()
      if (cursor.eat('=')) {
        const token = cursor.next()
        if (token?.kind === 'number') {
          value.value = Number(token.value)
          next = value.value + 1
        }
      } else if (!rule && !serdeValue(variantAttributes, 'rename')) value.value = next++
      const rename = serdeValue(variantAttributes, 'rename') ?? (rule ? renameAll(value.name, rule) : undefined)
      if (rename !== undefined) value.value = rename
      enumDef.values.push(value)
      cursor.eat(',')
    }
    cursor.eat('}')
    this.declarations.enums.push(enumDef)
  }
}

export const rustParser: InputParser = {
  id: 'rust',
  kind: 'code',
  label: 'Rust',
  extensions: ['.rs'],
  editorLanguage: 'rust',
  detect(text) {
    if (/#\[derive\(/.test(text) || /^\s*use\s+[\w:]+(::\{[^}]*\})?\s*;/m.test(text)) return 0.95
    if (/\bpub\s+struct\s+\w+/.test(text) || /\bstruct\s+\w+\s*\{[^}]*:\s*(String|Vec<|Option<|i32|i64|u32|u64|f64|bool)/.test(text))
      return 0.9
    return 0
  },
  parse(text) {
    if (text.trim() === '') return failure('empty')
    let tokens: Token[]
    try {
      tokens = tokenize(text, LEXER)
    } catch (error) {
      if (error instanceof LexError) return failure(error.code, positionAt(text, error.index))
      throw error
    }
    const reader = new Reader(text, tokens)
    reader.run()
    if (reader.declarations.models.length === 0 && reader.declarations.enums.length === 0) return failure('noModels')
    const { schema, warnings } = buildSchema(reader.declarations, RUST_TYPES, 'rust', 'rust')
    return { ok: true, schema, warnings }
  },
}
