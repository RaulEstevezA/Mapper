import { primitive, type Annotation } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { applyAnnotations, readAtAnnotation } from './annotations.ts'
import { Cursor, LexError, tokenize, type LexerConfig, type Token } from './lexer.ts'
import { buildSchema, parseLiteral, type RawDeclarations, type RawEnum, type RawField, type TypeTable } from './raw.ts'
import { readType, type TypeSyntax } from './typeSyntax.ts'

const LEXER: LexerConfig = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  nestedComments: true,
  strings: [
    { open: '"""', close: '"""', escapes: false, multiline: true },
    { open: '"', close: '"', escapes: true, multiline: false },
  ],
  stringPrefixes: /^[sf]/,
}

const SYNTAX: TypeSyntax = { generics: '[]' }

export const SCALA_TYPES: TypeTable = {
  primitives: {
    String: primitive('string'),
    Char: primitive('string'),
    Int: primitive('integer', 32),
    Long: primitive('integer', 64),
    Short: primitive('integer', 16),
    Byte: primitive('integer', 8),
    BigInt: primitive('integer'),
    Double: primitive('float', 64),
    Float: primitive('float', 32),
    BigDecimal: primitive('decimal'),
    Boolean: primitive('boolean'),
    LocalDate: primitive('date'),
    LocalDateTime: primitive('datetime'),
    OffsetDateTime: primitive('datetime'),
    ZonedDateTime: primitive('datetime'),
    Instant: primitive('datetime'),
    LocalTime: primitive('time'),
    Duration: primitive('duration'),
    UUID: primitive('uuid'),
    Json: primitive('any'),
    JsValue: primitive('any'),
    Any: primitive('any'),
  },
  lists: ['List', 'Seq', 'Vector', 'Set', 'IndexedSeq', 'Iterable', 'Array', 'ArraySeq'],
  maps: ['Map'],
  optionals: ['Option'],
}

const MODIFIERS = new Set(['final', 'sealed', 'abstract', 'private', 'protected', 'implicit', 'lazy', 'override', 'open', 'case'])

function normalize(type: ReturnType<typeof readType>): ReturnType<typeof readType> {
  if (!type) return null
  // Array[Byte] is binary data
  if (type.name === 'Array' && type.args[0]?.name === 'Byte') return { name: 'Json', args: [] }
  return type
}

class Reader {
  readonly cursor: Cursor
  readonly source: string
  readonly declarations: RawDeclarations = { models: [], enums: [], aliases: new Map(), warnings: [] }
  /** sealed trait Status + case object Active extends Status: an enum */
  private readonly sealedTraits = new Map<string, RawEnum>()
  private namespace: string | undefined

  constructor(source: string, tokens: Token[]) {
    this.source = source
    this.cursor = new Cursor(tokens)
  }

  run() {
    const { cursor } = this
    while (!cursor.done) {
      if (cursor.is('package') && cursor.isIdent(1)) {
        cursor.next()
        let name = cursor.next().value
        while (cursor.is('.') && cursor.isIdent(1)) {
          cursor.next()
          name += `.${cursor.next().value}`
        }
        this.namespace = name
        continue
      }
      if (cursor.is('import')) {
        const line = cursor.next().line
        while (!cursor.done && cursor.peek()!.line === line) cursor.next()
        continue
      }
      const doc = cursor.peek()?.doc
      const annotations: Annotation[] = []
      while (cursor.is('@')) {
        const annotation = readAtAnnotation(cursor, this.source)
        if (annotation) annotations.push(annotation)
        else cursor.next()
      }
      const start = cursor.index
      const modifiers = new Set<string>()
      while (MODIFIERS.has(cursor.value()) && (cursor.isIdent(1) || cursor.is('class', 1))) modifiers.add(cursor.next().value)
      if (cursor.is('class') && cursor.isIdent(1)) {
        cursor.next()
        this.caseClass(modifiers.has('case'), annotations, doc)
      } else if (cursor.is('enum') && cursor.isIdent(1)) {
        cursor.next()
        this.scala3Enum(doc)
      } else if (cursor.is('trait') && cursor.isIdent(1) && modifiers.has('sealed')) {
        cursor.next()
        const name = cursor.next().value
        this.sealedTraits.set(name, { name, values: [], ...(doc ? { description: doc } : {}) })
        if (cursor.is('{')) cursor.skipGroup()
      } else if (cursor.is('object') && cursor.isIdent(1) && modifiers.has('case')) {
        // case object Active extends Status
        cursor.next()
        const name = cursor.next().value
        if (cursor.eat('extends') && cursor.isIdent()) this.sealedTraits.get(cursor.value())?.values.push({ name })
        if (cursor.is('{')) cursor.skipGroup()
      } else if (cursor.is('type') && cursor.isIdent(1) && cursor.is('=', 2)) {
        cursor.next()
        const name = cursor.next().value
        cursor.next()
        const type = normalize(readType(cursor, SYNTAX))
        if (type) this.declarations.aliases!.set(name, type)
      } else if (cursor.index === start) {
        if (cursor.is('{') || cursor.is('(')) cursor.skipGroup()
        else cursor.next()
      }
    }
    for (const enumDef of this.sealedTraits.values()) if (enumDef.values.length > 0) this.declarations.enums.push(enumDef)
  }

  private caseClass(isCase: boolean, annotations: Annotation[], doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const generics: string[] = []
    if (cursor.is('[')) {
      cursor.next()
      while (!cursor.done && !cursor.is(']')) {
        if (cursor.isIdent() && ['[', ','].includes(cursor.tokens[cursor.index - 1].value)) generics.push(cursor.value())
        cursor.next()
      }
      cursor.eat(']')
    }
    const fields: RawField[] = []
    if (cursor.is('(')) {
      cursor.next()
      while (!cursor.done && !cursor.is(')')) {
        const fieldAnnotations: Annotation[] = []
        while (cursor.is('@')) {
          const annotation = readAtAnnotation(cursor, this.source)
          if (annotation) fieldAnnotations.push(annotation)
          else cursor.next()
        }
        const isPrivate = cursor.is('private')
        while (['val', 'var', 'private', 'protected', 'override', 'implicit'].includes(cursor.value())) cursor.next()
        if (!cursor.isIdent() || !cursor.is(':', 1)) {
          cursor.skipUntil([','])
          cursor.eat(',')
          continue
        }
        const fieldName = cursor.next().value
        cursor.next()
        const typeStart = cursor.index
        const type = normalize(readType(cursor, SYNTAX))
        const field: RawField = { name: fieldName, type, typeText: cursor.textBetween(this.source, typeStart, cursor.index) }
        if (cursor.eat('=')) {
          const start = cursor.index
          cursor.skipUntil([','])
          const literal = parseLiteral(cursor.textBetween(this.source, start, cursor.index).replace(/^None$/, 'null'))
          if (literal !== undefined) field.defaultValue = literal
          field.optional = true
        }
        if (type?.name === 'Option') field.optional = field.optional ?? false
        if (!isPrivate && applyAnnotations(field, fieldAnnotations)) fields.push(field)
        cursor.eat(',')
      }
      cursor.eat(')')
    }
    // `extends`, `derives` and the body are not data
    while (!cursor.done && !cursor.peek()!.lineStart && !cursor.is('{')) cursor.next()
    if (cursor.is('{')) cursor.skipGroup()
    this.declarations.models.push({
      name,
      kind: isCase ? 'record' : 'class',
      fields,
      generics,
      construction: 'named',
      ...(this.namespace ? { namespace: this.namespace } : {}),
      ...(doc ? { description: doc } : {}),
      ...(annotations.length > 0 ? { annotations } : {}),
    })
  }

  /** Scala 3: `enum Status { case Active, Blocked }` or with an indented body (`enum Status:`). */
  private scala3Enum(doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const enumDef: RawEnum = { name, values: [], ...(doc ? { description: doc } : {}) }
    if (cursor.is('(')) cursor.skipGroup()
    const braces = cursor.eat('{')
    if (!braces) cursor.eat(':')
    const column = cursor.peek()?.column ?? 0
    while (!cursor.done && !(braces ? cursor.is('}') : cursor.peek()!.lineStart && cursor.peek()!.column < column)) {
      if (cursor.eat('case')) {
        do {
          if (!cursor.isIdent()) break
          enumDef.values.push({ name: cursor.next().value })
          if (cursor.is('(')) cursor.skipGroup()
          if (cursor.is('extends')) while (!cursor.done && !cursor.peek()!.lineStart && !cursor.is(',')) cursor.next()
        } while (cursor.eat(','))
      } else if (cursor.is('{')) cursor.skipGroup()
      else cursor.next()
    }
    if (braces) cursor.eat('}')
    this.declarations.enums.push(enumDef)
  }
}

export const scalaParser: InputParser = {
  id: 'scala',
  kind: 'code',
  label: 'Scala',
  extensions: ['.scala', '.sc'],
  editorLanguage: 'scala',
  detect(text) {
    if (/\bcase\s+class\s+\w+/.test(text)) return 0.95
    if (/\bsealed\s+trait\s+\w+/.test(text) || (/^\s*enum\s+\w+\s*(:|\{)/m.test(text) && /\bcase\s+\w+/.test(text))) return 0.8
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
    const { schema, warnings } = buildSchema(reader.declarations, SCALA_TYPES, 'scala', 'scala')
    return { ok: true, schema, warnings }
  },
}
