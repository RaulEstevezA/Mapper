import { primitive, type Annotation } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { Cursor, LexError, tokenize, type LexerConfig, type Token } from './lexer.ts'
import { buildSchema, type RawDeclarations, type RawEnum, type RawField, type RawModel, type RawType, type TypeTable } from './raw.ts'
import { readType, type TypeSyntax } from './typeSyntax.ts'

const LEXER: LexerConfig = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: [
    { open: '`', close: '`', escapes: false, multiline: true },
    { open: '"', close: '"', escapes: true, multiline: false },
    { open: "'", close: "'", escapes: true, multiline: false },
  ],
}

const SYNTAX: TypeSyntax = { generics: '[]', pointers: true, goCollections: true }

export const GO_TYPES: TypeTable = {
  primitives: {
    string: primitive('string'),
    rune: primitive('integer', 32),
    int: primitive('integer', 64),
    int64: primitive('integer', 64),
    int32: primitive('integer', 32),
    int16: primitive('integer', 16),
    int8: primitive('integer', 8),
    uint: primitive('integer', 64),
    uint64: primitive('integer', 64),
    uint32: primitive('integer', 32),
    uint16: primitive('integer', 16),
    uint8: primitive('integer', 8),
    byte: primitive('integer', 8),
    float64: primitive('float', 64),
    float32: primitive('float', 32),
    bool: primitive('boolean'),
    'time.Time': primitive('datetime'),
    'time.Duration': primitive('duration'),
    'uuid.UUID': primitive('uuid'),
    'decimal.Decimal': primitive('decimal'),
    'big.Int': primitive('integer'),
    'big.Float': primitive('decimal'),
    'json.RawMessage': primitive('any'),
    'json.Number': primitive('float'),
    'sql.NullString': primitive('string'),
    'sql.NullInt64': primitive('integer', 64),
    'sql.NullFloat64': primitive('float', 64),
    'sql.NullBool': primitive('boolean'),
    'sql.NullTime': primitive('datetime'),
    '[]byte': primitive('binary'),
    any: primitive('any'),
    'interface{}': primitive('any'),
  },
  lists: [],
  maps: [],
  optionals: [],
}

/** The value of one key of a struct tag: `json:"name,omitempty" db:"user_name"` → `json` gives "name,omitempty". */
export function tagValue(tag: string, key: string): string | undefined {
  return new RegExp(`(?:^|\\s)${key}:"([^"]*)"`).exec(tag)?.[1]
}

class Reader {
  readonly cursor: Cursor
  readonly source: string
  readonly declarations: RawDeclarations = { models: [], enums: [], aliases: new Map(), warnings: [] }
  private namespace: string | undefined
  /** `type Status string`: candidates for enums, confirmed when constants of that type exist */
  private readonly namedTypes = new Map<string, { type: RawType; doc?: string }>()

  constructor(source: string, tokens: Token[]) {
    this.source = source
    this.cursor = new Cursor(tokens)
  }

  /** Types that need special names: `[]byte`, `interface{}`, `sql.NullString` (a nullable value). */
  private readGoType(): RawType | null {
    const { cursor } = this
    if (cursor.is('interface') && cursor.is('{', 1)) {
      cursor.next()
      cursor.skipGroup()
      return { name: 'interface{}', args: [] }
    }
    if (cursor.is('struct') && cursor.is('{', 1)) {
      // An anonymous struct: its fields are not a named model
      cursor.next()
      cursor.skipGroup()
      return { name: 'any', args: [] }
    }
    if (cursor.is('func')) {
      cursor.next()
      cursor.skipGroup()
      if (!cursor.peek()?.lineStart && !cursor.is('`')) readType(cursor, SYNTAX)
      return { name: 'any', args: [] }
    }
    const type = readType(cursor, SYNTAX)
    return type ? this.normalize(type) : null
  }

  private normalize(type: RawType): RawType {
    if (type.name === '[]' && type.args[0]?.name === 'byte' && !type.args[0].nullable)
      return { name: '[]byte', args: [], nullable: type.nullable }
    if (/^sql\.Null/.test(type.name)) return { ...type, nullable: true }
    return { ...type, args: type.args.map((arg) => this.normalize(arg)) }
  }

  run() {
    const { cursor } = this
    while (!cursor.done) {
      if (cursor.is('package') && cursor.isIdent(1)) {
        cursor.next()
        this.namespace = cursor.next().value
        continue
      }
      if (cursor.is('import')) {
        cursor.next()
        if (cursor.is('(')) cursor.skipGroup()
        else cursor.next()
        continue
      }
      if (cursor.is('type')) {
        const doc = cursor.peek()?.doc
        cursor.next()
        if (cursor.is('(')) {
          cursor.next()
          while (!cursor.done && !cursor.is(')')) {
            if (cursor.isIdent()) this.typeSpec(cursor.peek()?.doc ?? doc)
            else cursor.next()
          }
          cursor.eat(')')
        } else if (cursor.isIdent()) this.typeSpec(doc)
        continue
      }
      if (cursor.is('const')) {
        cursor.next()
        this.constants()
        continue
      }
      if (cursor.is('func')) {
        // Skip to the body and over it
        cursor.next()
        while (!cursor.done && !cursor.is('{')) {
          if (cursor.is('(')) cursor.skipGroup()
          else cursor.next()
        }
        cursor.skipGroup()
        continue
      }
      if (cursor.is('{') || cursor.is('(')) cursor.skipGroup()
      else cursor.next()
    }
    // Named types with constants became enums; the rest are aliases of their underlying type
    for (const [name, { type }] of this.namedTypes) {
      if (!this.declarations.enums.some((item) => item.name === name)) this.declarations.aliases!.set(name, type)
    }
  }

  private typeSpec(doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const generics: string[] = []
    // Type parameters: type Page[T any] struct
    if (cursor.is('[') && cursor.isIdent(1) && !cursor.is(']', 1) && (cursor.isIdent(2) || cursor.is(',', 2))) {
      cursor.next()
      while (!cursor.done && !cursor.is(']')) {
        if (cursor.isIdent() && ['[', ','].includes(cursor.tokens[cursor.index - 1].value)) generics.push(cursor.value())
        cursor.next()
      }
      cursor.eat(']')
    }
    cursor.eat('=')
    if (cursor.is('struct') && cursor.is('{', 1)) {
      cursor.next()
      const model: RawModel = { name, kind: 'struct', fields: [], generics, construction: 'named' }
      if (this.namespace) model.namespace = this.namespace
      if (doc) model.description = doc
      this.declarations.models.push(model)
      this.structBody(model)
      return
    }
    if (cursor.is('interface')) {
      cursor.next()
      if (cursor.is('{')) cursor.skipGroup()
      return
    }
    const type = this.readGoType()
    if (type) this.namedTypes.set(name, { type, ...(doc ? { doc } : {}) })
  }

  private structBody(model: RawModel) {
    const { cursor } = this
    cursor.next()
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.eat(';')) continue
      const doc = cursor.peek()?.doc
      const lineStart = cursor.index
      const names: string[] = []
      // `A, B int` declares several fields; a lone type is an embedded struct
      while (
        cursor.isIdent() &&
        (cursor.is(',', 1) || (!cursor.is('.', 1) && !cursor.peek(1)?.lineStart && !cursor.is('}', 1) && cursor.peek(1)?.kind !== 'string'))
      ) {
        names.push(cursor.next().value)
        if (!cursor.eat(',')) break
      }
      if (names.length === 0 || cursor.peek()?.lineStart || cursor.is('}') || cursor.peek()?.kind === 'string') {
        // Embedded struct: its fields are promoted, like inheritance
        cursor.index = lineStart
        cursor.eat('*')
        const embedded = readType(cursor, SYNTAX)
        if (embedded) model.extends = [...(model.extends ?? []), embedded.name.split('.').pop()!]
        if (cursor.peek()?.kind === 'string' && !cursor.peek()?.lineStart) cursor.next()
        continue
      }
      const typeStart = cursor.index
      const type = this.readGoType()
      const typeText = cursor.textBetween(this.source, typeStart, cursor.index)
      const tagToken = cursor.peek()?.kind === 'string' && !cursor.peek()?.lineStart ? cursor.next() : undefined
      const tag = tagToken?.value ?? ''
      for (const name of names) {
        // Unexported fields are never encoded
        if (!/^\p{Lu}/u.test(name)) continue
        const field: RawField = { name, type, typeText }
        if (doc) field.description = doc
        if (tag) {
          const annotations: Annotation[] = [{ name: 'tag', args: tag }]
          field.annotations = annotations
          const json = tagValue(tag, 'json')
          if (json === '-') continue
          if (json) {
            const [wire, ...options] = json.split(',')
            if (wire) field.serializedName = wire
            if (options.includes('omitempty') || options.includes('omitzero')) field.optional = true
          }
          const db = tagValue(tag, 'db') ?? /column:(\w+)/.exec(tagValue(tag, 'gorm') ?? '')?.[1]
          if (db && !field.serializedName) field.serializedName = db
          const gorm = tagValue(tag, 'gorm') ?? ''
          if (/autoIncrement|autoCreateTime|autoUpdateTime/.test(gorm)) field.generated = true
          if (gorm === '-') continue
          if (/(^|,)required(,|$)/.test(tagValue(tag, 'validate') ?? tagValue(tag, 'binding') ?? '')) field.optional = false
        }
        model.fields.push(field)
      }
    }
    cursor.eat('}')
  }

  /** `const ( StatusActive Status = "active"; StatusPaid Status = "paid" )`, also with `iota`. */
  private constants() {
    const { cursor } = this
    const grouped = cursor.eat('(')
    let currentType: string | undefined
    let iota = 0
    let usesIota = false
    do {
      if (grouped && cursor.is(')')) break
      if (!cursor.isIdent()) {
        cursor.next()
        continue
      }
      const name = cursor.next().value
      let typeName: string | undefined
      if (cursor.isIdent() && !cursor.is('=')) typeName = cursor.next().value
      let value: string | number | undefined
      if (cursor.eat('=')) {
        const token = cursor.peek()
        if (token?.kind === 'string') value = token.value
        else if (token?.kind === 'number') value = Number(token.value)
        else if (token?.value === 'iota') {
          usesIota = true
          value = iota
        }
        while (!cursor.done && !cursor.peek()!.lineStart && !cursor.is(')')) cursor.next()
        if (typeName) currentType = typeName
        else if (value !== undefined && !usesIota) currentType = undefined
      } else if (usesIota) value = iota
      iota++
      const enumType = typeName ?? (usesIota ? currentType : undefined)
      if (enumType && this.namedTypes.has(enumType)) {
        let enumDef = this.declarations.enums.find((item) => item.name === enumType)
        if (!enumDef) {
          enumDef = { name: enumType, values: [] } satisfies RawEnum
          const doc = this.namedTypes.get(enumType)!.doc
          if (doc) enumDef.description = doc
          this.declarations.enums.push(enumDef)
        }
        // StatusActive → value "active": the constant name is kept as the value's name
        enumDef.values.push({ name, ...(value !== undefined ? { value } : {}) })
      }
    } while (grouped && !cursor.done)
    cursor.eat(')')
  }
}

export const goParser: InputParser = {
  id: 'go',
  kind: 'code',
  label: 'Go',
  extensions: ['.go'],
  editorLanguage: 'go',
  detect(text) {
    if (/\btype\s+\w+\s+struct\s*\{/.test(text)) return 0.95
    // `package x` alone is also Scala, Java without `;`, Kotlin: Go needs one of its own signs too
    if (/^\s*package\s+\w+\s*$/m.test(text)) return /^\s*(func\s|import\s+(\(|"))/m.test(text) ? 0.9 : 0.4
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
    const { schema, warnings } = buildSchema(reader.declarations, GO_TYPES, 'go', 'go')
    return { ok: true, schema, warnings }
  },
}
