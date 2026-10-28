import { primitive, type Annotation } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { applyAnnotations, readAtAnnotation } from './annotations.ts'
import { Cursor, LexError, tokenize, type LexerConfig, type Token } from './lexer.ts'
import { buildSchema, parseLiteral, type RawDeclarations, type RawEnum, type RawField, type RawModel, type TypeTable } from './raw.ts'
import { readType, type TypeSyntax } from './typeSyntax.ts'

const LEXER: LexerConfig = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  nestedComments: true,
  strings: [
    { open: '"""', close: '"""', escapes: false, multiline: true },
    { open: '"', close: '"', escapes: true, multiline: false },
    { open: "'", close: "'", escapes: true, multiline: false },
  ],
}

const SYNTAX: TypeSyntax = { generics: '<>', nullableSuffix: true }

export const KOTLIN_TYPES: TypeTable = {
  primitives: {
    String: primitive('string'),
    Char: primitive('string'),
    Int: primitive('integer', 32),
    UInt: primitive('integer', 32),
    Long: primitive('integer', 64),
    ULong: primitive('integer', 64),
    Short: primitive('integer', 16),
    Byte: primitive('integer', 8),
    BigInteger: primitive('integer'),
    Double: primitive('float', 64),
    Float: primitive('float', 32),
    BigDecimal: primitive('decimal'),
    Boolean: primitive('boolean'),
    LocalDate: primitive('date'),
    LocalDateTime: primitive('datetime'),
    OffsetDateTime: primitive('datetime'),
    ZonedDateTime: primitive('datetime'),
    Instant: primitive('datetime'),
    Date: primitive('datetime'),
    LocalTime: primitive('time'),
    Duration: primitive('duration'),
    UUID: primitive('uuid'),
    Uuid: primitive('uuid'),
    ByteArray: primitive('binary'),
    Any: primitive('any'),
    JsonElement: primitive('any'),
  },
  lists: [
    'List',
    'MutableList',
    'ArrayList',
    'Set',
    'MutableSet',
    'HashSet',
    'LinkedHashSet',
    'Collection',
    'Iterable',
    'Array',
    'Sequence',
  ],
  maps: ['Map', 'MutableMap', 'HashMap', 'LinkedHashMap'],
  optionals: [],
}

const MODIFIERS = new Set([
  'data',
  'open',
  'abstract',
  'sealed',
  'inner',
  'private',
  'public',
  'internal',
  'protected',
  'override',
  'lateinit',
  'value',
  'inline',
  'const',
  'final',
  'external',
  'expect',
  'actual',
  'suspend',
  'operator',
  'infix',
  'tailrec',
  'vararg',
  'noinline',
  'crossinline',
])

class Reader {
  readonly cursor: Cursor
  readonly source: string
  readonly declarations: RawDeclarations = { models: [], enums: [], aliases: new Map(), warnings: [] }
  private namespace: string | undefined

  constructor(source: string, tokens: Token[]) {
    this.source = source
    this.cursor = new Cursor(tokens)
  }

  run() {
    const { cursor } = this
    while (!cursor.done) {
      if (cursor.is('package') && cursor.peek()?.lineStart) {
        cursor.next()
        let name = ''
        while (cursor.isIdent() || cursor.is('.')) {
          const token = cursor.next()
          name += token.value
          if (cursor.peek()?.lineStart) break
        }
        this.namespace = name
        continue
      }
      if (cursor.is('import') && cursor.peek()?.lineStart) {
        cursor.next()
        while (!cursor.done && !cursor.peek()!.lineStart) cursor.next()
        continue
      }
      if (cursor.is('typealias') && cursor.isIdent(1)) {
        cursor.next()
        const name = cursor.next().value
        if (cursor.eat('=')) {
          const type = readType(cursor, SYNTAX)
          if (type) this.declarations.aliases!.set(name, type)
        }
        continue
      }
      if (!this.declaration()) cursor.next()
    }
  }

  private declaration(): boolean {
    const { cursor } = this
    const start = cursor.index
    const doc = cursor.peek()?.doc
    const annotations: Annotation[] = []
    const modifiers = new Set<string>()
    for (;;) {
      if (cursor.is('@')) {
        const annotation = readAtAnnotation(cursor, this.source)
        if (annotation) annotations.push(annotation)
        else cursor.next()
      } else if (
        MODIFIERS.has(cursor.value()) ||
        (cursor.is('enum') && cursor.is('class', 1)) ||
        (cursor.is('annotation') && cursor.is('class', 1))
      ) {
        modifiers.add(cursor.next().value)
      } else break
    }
    if (cursor.is('class') && cursor.isIdent(1)) {
      cursor.next()
      if (modifiers.has('enum')) this.enumDeclaration(doc)
      else if (modifiers.has('annotation')) this.skipDeclaration()
      else this.classDeclaration(modifiers, annotations, doc)
      return true
    }
    if ((cursor.is('interface') || cursor.is('object')) && (cursor.isIdent(1) || cursor.is(':', 1) || cursor.is('{', 1))) {
      cursor.next()
      this.skipDeclaration()
      return true
    }
    if (cursor.is('companion') && cursor.is('object', 1)) {
      cursor.next()
      cursor.next()
      this.skipDeclaration()
      return true
    }
    cursor.index = start
    return false
  }

  private skipDeclaration() {
    const { cursor } = this
    while (!cursor.done && !cursor.is('{') && !cursor.is('}') && !(cursor.peek()!.lineStart && cursor.index > 0)) cursor.next()
    if (cursor.is('{')) cursor.skipGroup()
  }

  private typeParameters(): string[] {
    const { cursor } = this
    const names: string[] = []
    if (!cursor.is('<')) return names
    let depth = 0
    do {
      const token = cursor.next()
      if (token.value === '<') depth++
      else if (token.value === '>') depth--
      else if (
        depth === 1 &&
        token.kind === 'ident' &&
        ['<', ','].includes(cursor.tokens[cursor.index - 2]?.value) &&
        !['in', 'out', 'reified'].includes(token.value)
      ) {
        names.push(token.value)
      } else if (depth === 1 && token.kind === 'ident' && ['in', 'out', 'reified'].includes(cursor.tokens[cursor.index - 2]?.value))
        names.push(token.value)
    } while (!cursor.done && depth > 0)
    return names
  }

  private classDeclaration(modifiers: Set<string>, annotations: Annotation[], doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const model: RawModel = { name, kind: 'class', fields: [], generics: this.typeParameters(), construction: 'properties' }
    if (this.namespace) model.namespace = this.namespace
    if (doc) model.description = doc
    if (annotations.length > 0) model.annotations = annotations
    if (annotations.some((item) => item.name === 'Entity')) {
      model.kind = 'entity'
      model.framework = 'jpa'
    }
    if (modifiers.has('data')) model.kind = model.kind === 'entity' ? 'entity' : 'record'
    // A primary constructor, possibly after annotations and `constructor`
    while (cursor.is('@') || cursor.is('constructor') || MODIFIERS.has(cursor.value())) {
      if (cursor.is('@')) readAtAnnotation(cursor, this.source)
      else cursor.next()
    }
    if (cursor.is('(')) {
      model.fields = this.constructorParameters()
      model.construction = 'named'
    }
    model.extends = []
    if (cursor.eat(':')) {
      do {
        const parent = readType(cursor, SYNTAX)
        if (parent) model.extends.push(parent.name.split('.').pop()!)
        if (cursor.is('(')) cursor.skipGroup()
        if (cursor.eat('by')) readType(cursor, SYNTAX)
      } while (cursor.eat(','))
    }
    // `where T : Comparable<T>` constraints
    if (cursor.eat('where')) while (!cursor.done && !cursor.is('{') && !cursor.peek()!.lineStart) cursor.next()
    this.declarations.models.push(model)
    if (cursor.is('{')) model.fields.push(...this.body())
  }

  private constructorParameters(): RawField[] {
    const { cursor } = this
    const fields: RawField[] = []
    cursor.next()
    while (!cursor.done && !cursor.is(')')) {
      const annotations: Annotation[] = []
      let property = false
      let isPrivate = false
      for (;;) {
        if (cursor.is('@')) {
          const annotation = readAtAnnotation(cursor, this.source)
          if (annotation) annotations.push(annotation)
          else cursor.next()
        } else if (cursor.is('val') || cursor.is('var')) {
          cursor.next()
          property = true
        } else if (MODIFIERS.has(cursor.value()) && cursor.isIdent(1)) {
          if (cursor.next().value === 'private') isPrivate = true
        } else break
      }
      if (!cursor.isIdent()) {
        cursor.skipUntil([','])
        cursor.eat(',')
        continue
      }
      const name = cursor.next().value
      cursor.eat(':')
      const typeStart = cursor.index
      const type = readType(cursor, SYNTAX)
      const field: RawField = { name, type, typeText: cursor.textBetween(this.source, typeStart, cursor.index) }
      if (cursor.eat('=')) {
        const start = cursor.index
        cursor.skipUntil([','])
        const literal = parseLiteral(cursor.textBetween(this.source, start, cursor.index))
        if (literal !== undefined) field.defaultValue = literal
        field.optional = true
      }
      if (property && !isPrivate && applyAnnotations(field, annotations)) fields.push(field)
      cursor.eat(',')
    }
    cursor.eat(')')
    return fields
  }

  private body(): RawField[] {
    const { cursor } = this
    const fields: RawField[] = []
    cursor.next()
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.eat(';')) continue
      const memberStart = cursor.index
      if (this.declaration()) continue
      cursor.index = memberStart
      const doc = cursor.peek()?.doc
      const annotations: Annotation[] = []
      const modifiers = new Set<string>()
      for (;;) {
        if (cursor.is('@')) {
          const annotation = readAtAnnotation(cursor, this.source)
          if (annotation) annotations.push(annotation)
          else cursor.next()
        } else if (MODIFIERS.has(cursor.value())) modifiers.add(cursor.next().value)
        else break
      }
      if (cursor.is('init') && cursor.is('{', 1)) {
        cursor.next()
        cursor.skipGroup()
        continue
      }
      if (cursor.is('fun') || cursor.is('constructor')) {
        this.skipFunction()
        continue
      }
      if (!(cursor.is('val') || cursor.is('var'))) {
        this.skipLine()
        continue
      }
      cursor.next()
      if (!cursor.isIdent()) {
        this.skipLine()
        continue
      }
      // Extension properties (`val String.x`) are not fields
      if (cursor.is('.', 1)) {
        this.skipLine()
        continue
      }
      const nameToken = cursor.next()
      let type = null
      let typeText: string | undefined
      if (cursor.eat(':')) {
        const typeStart = cursor.index
        type = readType(cursor, SYNTAX)
        typeText = cursor.textBetween(this.source, typeStart, cursor.index)
      }
      const field: RawField = { name: nameToken.value, type }
      if (typeText) field.typeText = typeText
      if (doc) field.description = doc
      let computed = false
      if (cursor.eat('=')) {
        const start = cursor.index
        this.skipLine()
        const text = cursor.textBetween(this.source, start, cursor.index)
        const literal = parseLiteral(text)
        if (literal !== undefined) field.defaultValue = literal
        if (!type && literal !== undefined && literal !== null) {
          field.type = {
            name:
              typeof literal === 'string'
                ? 'String'
                : typeof literal === 'boolean'
                  ? 'Boolean'
                  : Number.isInteger(literal)
                    ? 'Int'
                    : 'Double',
            args: [],
          }
        }
      } else if (cursor.eat('by')) {
        computed = true
        this.skipLine()
      }
      // A custom getter (`val full get() = …`) computes the value
      if (cursor.is('get') && (cursor.is('(', 1) || cursor.is('=', 1))) {
        computed = true
        this.skipFunction()
      }
      if (cursor.is('private') && cursor.is('set', 1)) {
        cursor.next()
        cursor.next()
      }
      if (computed || modifiers.has('private') || modifiers.has('const') || !field.type) continue
      if (applyAnnotations(field, annotations)) fields.push(field)
    }
    cursor.eat('}')
    return fields
  }

  /** Skips to the start of the next line (outside brackets) or the closing brace of the body. */
  private skipLine() {
    const { cursor } = this
    const start = cursor.index
    let depth = 0
    while (!cursor.done) {
      const token = cursor.peek()!
      if (cursor.index > start && depth === 0 && token.lineStart) return
      if (token.kind === 'punct') {
        if ('([{'.includes(token.value)) depth++
        else if (')]}'.includes(token.value)) {
          if (depth === 0) return
          depth--
        }
      }
      cursor.next()
    }
  }

  private skipFunction() {
    const { cursor } = this
    while (!cursor.done && !cursor.is('(')) cursor.next()
    cursor.skipGroup()
    if (cursor.eat(':')) readType(cursor, SYNTAX)
    if (cursor.is('{')) cursor.skipGroup()
    else if (cursor.eat('=')) this.skipLine()
  }

  private enumDeclaration(doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const enumDef: RawEnum = { name, values: [] }
    if (this.namespace) enumDef.namespace = this.namespace
    if (doc) enumDef.description = doc
    if (cursor.is('(')) cursor.skipGroup()
    while (!cursor.done && !cursor.is('{')) cursor.next()
    if (!cursor.eat('{')) return
    while (!cursor.done && !cursor.is('}') && !cursor.is(';')) {
      while (cursor.is('@')) readAtAnnotation(cursor, this.source)
      if (!cursor.isIdent()) {
        cursor.next()
        continue
      }
      const value: RawEnum['values'][number] = { name: cursor.next().value }
      if (cursor.is('(')) {
        const first = cursor.peek(1)
        if (first?.kind === 'string') value.value = first.value
        else if (first?.kind === 'number') value.value = Number(first.value)
        cursor.skipGroup()
      }
      if (cursor.is('{')) cursor.skipGroup()
      enumDef.values.push(value)
      cursor.eat(',')
    }
    let depth = 1
    while (!cursor.done && depth > 0) {
      const token = cursor.next()
      if (token.kind !== 'punct') continue
      if (token.value === '{') depth++
      else if (token.value === '}') depth--
    }
    this.declarations.enums.push(enumDef)
  }
}

export const kotlinParser: InputParser = {
  id: 'kotlin',
  kind: 'code',
  label: 'Kotlin',
  extensions: ['.kt', '.kts'],
  editorLanguage: 'kotlin',
  detect(text) {
    if (/\bdata\s+class\s+\w+/.test(text)) return 0.95
    if (/\b(val|var)\s+\w+\s*:\s*[\w<>?, ]+/.test(text) && /\bclass\s+\w+/.test(text) && !/;\s*$/m.test(text)) return 0.8
    if (/\benum\s+class\s+\w+/.test(text)) return 0.8
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
    const { schema, warnings } = buildSchema(reader.declarations, KOTLIN_TYPES, 'kotlin', 'kotlin')
    return { ok: true, schema, warnings }
  },
}
