import { primitive, type Annotation } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { applyAnnotations, readAtAnnotation } from './annotations.ts'
import { C_LIKE, Cursor, LexError, tokenize, type LexerConfig, type Token } from './lexer.ts'
import {
  buildSchema,
  parseLiteral,
  type RawDeclarations,
  type RawEnum,
  type RawField,
  type RawModel,
  type RawType,
  type TypeTable,
} from './raw.ts'
import { readType, type TypeSyntax } from './typeSyntax.ts'

const LEXER: LexerConfig = {
  ...C_LIKE,
  // Text blocks (Java 15)
  strings: [{ open: '"""', close: '"""', escapes: true, multiline: true }, ...C_LIKE.strings],
}

const SYNTAX: TypeSyntax = { generics: '<>', arraySuffix: true }

export const JAVA_TYPES: TypeTable = {
  primitives: {
    String: primitive('string'),
    CharSequence: primitive('string'),
    char: primitive('string'),
    int: primitive('integer', 32),
    long: primitive('integer', 64),
    short: primitive('integer', 16),
    byte: primitive('integer', 8),
    BigInteger: primitive('integer'),
    double: primitive('float', 64),
    float: primitive('float', 32),
    BigDecimal: primitive('decimal'),
    boolean: primitive('boolean'),
    LocalDate: primitive('date'),
    LocalDateTime: primitive('datetime'),
    OffsetDateTime: primitive('datetime'),
    ZonedDateTime: primitive('datetime'),
    Instant: primitive('datetime'),
    Date: primitive('datetime'),
    Timestamp: primitive('datetime'),
    LocalTime: primitive('time'),
    Duration: primitive('duration'),
    UUID: primitive('uuid'),
    'byte[]': primitive('binary'),
    Object: primitive('any'),
    JsonNode: primitive('any'),
  },
  // Boxed types are chosen precisely because the value may be missing
  nullablePrimitives: {
    Integer: primitive('integer', 32),
    Long: primitive('integer', 64),
    Short: primitive('integer', 16),
    Byte: primitive('integer', 8),
    Double: primitive('float', 64),
    Float: primitive('float', 32),
    Boolean: primitive('boolean'),
    Character: primitive('string'),
  },
  lists: ['List', 'ArrayList', 'LinkedList', 'Set', 'HashSet', 'TreeSet', 'LinkedHashSet', 'SortedSet', 'Collection', 'Iterable'],
  maps: ['Map', 'HashMap', 'TreeMap', 'LinkedHashMap', 'SortedMap', 'ConcurrentHashMap'],
  optionals: ['Optional'],
}

const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'static',
  'final',
  'abstract',
  'sealed',
  'non-sealed',
  'strictfp',
  'transient',
  'volatile',
  'default',
  'synchronized',
  'native',
])

/** `byte[]` is binary data, not a list of numbers. */
function normalize(type: RawType | null): RawType | null {
  if (!type) return null
  if (type.name === '[]' && type.args[0]?.name === 'byte') return { name: 'byte[]', args: [] }
  return { ...type, args: type.args.map((arg) => normalize(arg)!).filter(Boolean) }
}

class Reader {
  readonly cursor: Cursor
  readonly source: string
  readonly declarations: RawDeclarations = { models: [], enums: [], warnings: [] }
  private namespace: string | undefined
  /** Classes being read, outermost first: a nested class is referred to as Outer.Inner */
  private readonly enclosing: string[] = []

  constructor(source: string, tokens: Token[]) {
    this.source = source
    this.cursor = new Cursor(tokens)
  }

  run() {
    const { cursor } = this
    while (!cursor.done) {
      if (cursor.is('package')) {
        cursor.next()
        const start = cursor.index
        cursor.skipUntil([';'])
        this.namespace = cursor.textBetween(this.source, start, cursor.index).replace(/\s+/g, '')
        cursor.eat(';')
        continue
      }
      if (cursor.is('import')) {
        cursor.skipUntil([';'])
        cursor.eat(';')
        continue
      }
      if (!this.declaration()) cursor.next()
    }
  }

  /** Reads one type declaration (with its annotations and modifiers) at the cursor. Returns false when
   * there is none, leaving the cursor where it was. */
  private declaration(): boolean {
    const { cursor } = this
    const start = cursor.index
    const doc = cursor.peek()?.doc
    const annotations: Annotation[] = []
    for (;;) {
      if (cursor.is('@') && !cursor.is('interface', 1)) {
        const annotation = readAtAnnotation(cursor, this.source)
        if (annotation) annotations.push(annotation)
        else cursor.next()
      } else if (MODIFIERS.has(cursor.value())) cursor.next()
      else break
    }
    const keyword = cursor.value()
    if ((keyword === 'class' || keyword === 'record') && cursor.isIdent(1)) {
      cursor.next()
      this.classDeclaration(keyword, annotations, doc)
      return true
    }
    if (keyword === 'enum' && cursor.isIdent(1)) {
      cursor.next()
      this.enumDeclaration(doc)
      return true
    }
    if ((keyword === 'interface' || (keyword === '@' && cursor.is('interface', 1))) && !cursor.done) {
      // Interfaces and annotation types hold no data
      while (!cursor.done && !cursor.is('{')) cursor.next()
      cursor.skipGroup()
      return true
    }
    cursor.index = start
    return false
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
      else if (depth === 1 && token.kind === 'ident' && ['<', ','].includes(cursor.tokens[cursor.index - 2]?.value)) names.push(token.value)
    } while (!cursor.done && depth > 0)
    return names
  }

  private classDeclaration(keyword: string, annotations: Annotation[], doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const model: RawModel = { name, kind: keyword === 'record' ? 'record' : 'class', fields: [], generics: this.typeParameters() }
    if (this.namespace) model.namespace = this.namespace
    if (doc) model.description = doc
    if (annotations.length > 0) model.annotations = annotations
    const names = new Set(annotations.map((item) => item.name.split('.').pop()))
    if (names.has('Entity') || names.has('Embeddable') || names.has('MappedSuperclass')) {
      model.kind = 'entity'
      model.framework = 'jpa'
    }
    if (keyword === 'record') {
      model.construction = 'positional'
      model.fields = this.recordComponents()
    } else {
      // Lombok's @Builder gives a builder; otherwise objects are filled with setters
      model.construction = 'properties'
      if (names.has('Builder') || names.has('SuperBuilder')) model.metadata = { builder: true }
    }
    model.extends = []
    while (!cursor.done && !cursor.is('{')) {
      if (cursor.eat('extends')) {
        const parent = readType(cursor, SYNTAX)
        if (parent) model.extends.push(parent.name.split('.').pop()!)
      } else cursor.next()
    }
    this.declarations.models.push(model)
    if (this.enclosing.length > 0) model.metadata = { ...model.metadata, outer: this.enclosing.join('.') }
    this.enclosing.push(name)
    const { fields, getters, publicFields } = this.body(name)
    this.enclosing.pop()
    model.fields.push(...fields)
    // Records are read with name(); classes with getters unless they only expose public fields
    const lombok = names.has('Data') || names.has('Getter') || names.has('Value')
    const accessors = keyword === 'record' ? 'record' : !lombok && getters === 0 && publicFields > 0 ? 'fields' : 'getters'
    model.metadata = { ...model.metadata, accessors }
  }

  private recordComponents(): RawField[] {
    const { cursor } = this
    const fields: RawField[] = []
    if (!cursor.eat('(')) return fields
    while (!cursor.done && !cursor.is(')')) {
      const annotations: Annotation[] = []
      while (cursor.is('@')) {
        const annotation = readAtAnnotation(cursor, this.source)
        if (annotation) annotations.push(annotation)
        else break
      }
      cursor.eat('final')
      const typeStart = cursor.index
      const type = normalize(readType(cursor, SYNTAX))
      const typeText = cursor.textBetween(this.source, typeStart, cursor.index)
      if (cursor.eat('...')) {
        // Varargs: an array
      }
      if (!cursor.isIdent()) {
        cursor.skipUntil([','])
        cursor.eat(',')
        continue
      }
      const field: RawField = { name: cursor.next().value, type, typeText }
      if (applyAnnotations(field, annotations)) fields.push(field)
      cursor.eat(',')
    }
    cursor.eat(')')
    return fields
  }

  /** Fields of a class body. Nested types are read as models of their own. */
  private body(owner: string): { fields: RawField[]; getters: number; publicFields: number } {
    const { cursor } = this
    const fields: RawField[] = []
    let getters = 0
    let publicFields = 0
    if (!cursor.eat('{')) return { fields, getters, publicFields }
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.eat(';')) continue
      if (cursor.is('{')) {
        // Initializer block
        cursor.skipGroup()
        continue
      }
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
      if (cursor.is('<')) {
        // Generic method
        this.typeParameters()
      }
      // Constructor: Name(
      if (cursor.is(owner) && cursor.is('(', 1)) {
        this.skipMethod()
        continue
      }
      const typeStart = cursor.index
      const type = normalize(readType(cursor, SYNTAX))
      const typeText = cursor.textBetween(this.source, typeStart, cursor.index)
      if (!type || !cursor.isIdent()) {
        cursor.skipUntil([';', '}'])
        cursor.eat(';')
        continue
      }
      if (cursor.is('(', 1)) {
        const methodName = cursor.value()
        if (/^(get|is)[A-Z]/.test(methodName) && cursor.is(')', 2)) getters++
        this.skipMethod()
        continue
      }
      // `int a, b = 2;` declares several fields
      for (;;) {
        const nameToken = cursor.next()
        let fieldType = type
        while (cursor.is('[') && cursor.is(']', 1)) {
          cursor.next()
          cursor.next()
          fieldType = { name: '[]', args: [fieldType] }
        }
        let initializer: string | undefined
        if (cursor.eat('=')) {
          const start = cursor.index
          cursor.skipUntil([',', ';'])
          initializer = cursor.textBetween(this.source, start, cursor.index)
        }
        if (!modifiers.has('static') && !modifiers.has('transient')) {
          const field: RawField = { name: nameToken.value, type: fieldType, typeText }
          if (doc) field.description = doc
          if (initializer !== undefined) {
            const literal = parseLiteral(initializer)
            if (literal !== undefined) field.defaultValue = literal
          }
          if (applyAnnotations(field, annotations)) {
            fields.push(field)
            if (modifiers.has('public')) publicFields++
          }
        }
        if (cursor.eat(',') && cursor.isIdent()) continue
        break
      }
      cursor.eat(';')
    }
    cursor.eat('}')
    return { fields, getters, publicFields }
  }

  private skipMethod() {
    const { cursor } = this
    while (!cursor.done && !cursor.is('(')) cursor.next()
    cursor.skipGroup()
    while (!cursor.done && !cursor.is('{') && !cursor.is(';') && !cursor.is('}')) cursor.next()
    if (cursor.is('{')) cursor.skipGroup()
    else cursor.eat(';')
  }

  private enumDeclaration(doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const enumDef: RawEnum = { name, values: [] }
    if (this.namespace) enumDef.namespace = this.namespace
    if (doc) enumDef.description = doc
    while (!cursor.done && !cursor.is('{')) cursor.next()
    if (!cursor.eat('{')) return
    while (!cursor.done && !cursor.is('}') && !cursor.is(';')) {
      while (cursor.is('@')) readAtAnnotation(cursor, this.source)
      if (!cursor.isIdent()) {
        cursor.next()
        continue
      }
      const value: RawEnum['values'][number] = { name: cursor.next().value }
      // PAID("paid", 2): the first argument is usually the value on the wire
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
    // Fields and methods of the enum
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

export const javaParser: InputParser = {
  id: 'java',
  kind: 'code',
  label: 'Java',
  extensions: ['.java'],
  editorLanguage: 'java',
  detect(text) {
    if (/^\s*package\s+[\w.]+\s*;/m.test(text)) return 0.95
    if (
      /\b(public|private|protected)\s+(record|class|enum)\s+\w+/.test(text) &&
      /\b(private|public|protected)\s+[\w<>[\], ?]+\s+\w+\s*[;=]/.test(text)
    )
      return 0.85
    if (/^\s*(public\s+)?record\s+\w+\s*\(/m.test(text)) return 0.8
    if (/@(Entity|Data|Getter|Column|Id)\b/.test(text) && /;\s*$/m.test(text) && !/\{\s*get;/.test(text)) return 0.6
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
    const { schema, warnings } = buildSchema(reader.declarations, JAVA_TYPES, 'java', 'java')
    return { ok: true, schema, warnings }
  },
}
