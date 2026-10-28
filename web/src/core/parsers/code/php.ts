import { primitive, type Annotation } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { applyAnnotations, readBracketAttributes } from './annotations.ts'
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
  lineComments: ['//', '#'],
  blockComments: [['/*', '*/']],
  strings: C_LIKE.strings,
  identifierChars: '$',
  hashAttributes: true,
}

const SYNTAX: TypeSyntax = { generics: '<>', nullablePrefix: true, unions: true, arraySuffix: true, separators: ['\\'] }

export const PHP_TYPES: TypeTable = {
  primitives: {
    string: primitive('string'),
    int: primitive('integer', 64),
    integer: primitive('integer', 64),
    float: primitive('float', 64),
    double: primitive('float', 64),
    bool: primitive('boolean'),
    boolean: primitive('boolean'),
    true: primitive('boolean'),
    false: primitive('boolean'),
    DateTime: primitive('datetime'),
    DateTimeImmutable: primitive('datetime'),
    DateTimeInterface: primitive('datetime'),
    Carbon: primitive('datetime'),
    CarbonImmutable: primitive('datetime'),
    DateInterval: primitive('duration'),
    UuidInterface: primitive('uuid'),
    Uuid: primitive('uuid'),
    mixed: primitive('any'),
    object: primitive('any'),
    stdClass: primitive('any'),
  },
  // `array` alone is a list of unknown items; docblocks usually say more (`@var Item[]`)
  lists: ['array', 'iterable', 'Collection', 'ArrayCollection', 'list', 'non-empty-array', 'non-empty-list'],
  maps: [],
  optionals: [],
  nullNames: ['null'],
  caseInsensitive: true,
}

const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'readonly', 'final', 'abstract', 'var'])
const VISIBILITY = new Set(['public', 'private', 'protected', 'readonly'])

const DOC_SYNTAX: TypeSyntax = { ...SYNTAX }

/** Type of a docblock tag (`@var Collection<int, Order>`, `@param list<Item> $items`). */
function docType(docRaw: string | undefined, pattern: RegExp): RawType | null {
  const match = docRaw ? pattern.exec(docRaw) : null
  if (!match) return null
  try {
    const type = readType(new Cursor(tokenize(match[1], LEXER)), DOC_SYNTAX)
    if (!type) return null
    // array<int, Item> and Collection<int, Item>: the last argument is the item
    if (
      type.args.length === 2 &&
      ['array', 'collection', 'arraycollection', 'iterable'].includes(type.name.split('\\').pop()!.toLowerCase())
    ) {
      return { name: '[]', args: [type.args[1]], nullable: type.nullable }
    }
    return type
  } catch {
    return null
  }
}

/** A docblock type is more precise when the declared type is just `array` or missing. */
function refine(declared: RawType | null, documented: RawType | null): RawType | null {
  if (!documented) return declared
  if (!declared) return documented
  const simple = (type: RawType) => type.name.split('\\').pop()!.toLowerCase()
  const plainList = (type: RawType) =>
    ['array', 'iterable', 'collection', 'arraycollection'].includes(simple(type)) && type.args.length === 0
  if (plainList(declared)) return { ...documented, nullable: declared.nullable || documented.nullable }
  if (declared.name === '|') return { ...declared, args: declared.args.map((arg) => (plainList(arg) ? documented : arg)) }
  return declared
}

class Reader {
  readonly cursor: Cursor
  readonly source: string
  readonly declarations: RawDeclarations = { models: [], enums: [], warnings: [] }
  private namespace: string | undefined

  constructor(source: string, tokens: Token[]) {
    this.source = source
    this.cursor = new Cursor(tokens)
  }

  run() {
    const { cursor } = this
    let attributes: Annotation[] = []
    while (!cursor.done) {
      if (cursor.is('#[')) {
        attributes.push(...readBracketAttributes(cursor, this.source))
        continue
      }
      if (cursor.is('namespace')) {
        cursor.next()
        const start = cursor.index
        while (!cursor.done && !cursor.is(';') && !cursor.is('{')) cursor.next()
        this.namespace = cursor.textBetween(this.source, start, cursor.index).replace(/\s+/g, '')
        cursor.next()
        continue
      }
      if (cursor.is('use') && cursor.peek()?.lineStart) {
        cursor.skipUntil([';'])
        cursor.eat(';')
        continue
      }
      const doc = cursor.peek()?.doc
      while (['final', 'abstract', 'readonly'].includes(cursor.value()) && cursor.isIdent(1)) cursor.next()
      if (cursor.is('class') && cursor.isIdent(1)) {
        cursor.next()
        this.classDeclaration(attributes, doc)
      } else if (cursor.is('enum') && cursor.isIdent(1)) {
        cursor.next()
        this.enumDeclaration(doc)
      } else if ((cursor.is('interface') || cursor.is('trait')) && cursor.isIdent(1)) {
        while (!cursor.done && !cursor.is('{')) cursor.next()
        cursor.skipGroup()
      } else if (cursor.is('{') || cursor.is('(')) cursor.skipGroup()
      else cursor.next()
      attributes = []
    }
  }

  private classDeclaration(attributes: Annotation[], doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const model: RawModel = { name, kind: 'class', fields: [], construction: 'properties' }
    if (this.namespace) model.namespace = this.namespace
    if (doc) model.description = doc
    if (attributes.length > 0) model.annotations = attributes
    if (attributes.some((item) => /(^|\\)Entity$/.test(item.name))) {
      model.kind = 'entity'
      model.framework = 'doctrine'
    }
    model.extends = []
    while (!cursor.done && !cursor.is('{')) {
      if (cursor.eat('extends')) {
        const parent = readType(cursor, SYNTAX)
        if (parent) model.extends.push(parent.name.split('\\').pop()!)
      } else cursor.next()
    }
    this.declarations.models.push(model)
    let getters = 0
    cursor.next()
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.eat(';')) continue
      const docRaw = cursor.peek()?.docRaw
      const memberDoc = cursor.peek()?.doc
      const memberAttributes: Annotation[] = []
      while (cursor.is('#[')) memberAttributes.push(...readBracketAttributes(cursor, this.source))
      const modifiers = new Set<string>()
      while (MODIFIERS.has(cursor.value())) modifiers.add(cursor.next().value)
      if (cursor.is('use')) {
        cursor.skipUntil([';'])
        cursor.eat(';')
        continue
      }
      if (cursor.is('const')) {
        cursor.skipUntil([';'])
        cursor.eat(';')
        continue
      }
      if (cursor.is('function')) {
        cursor.next()
        const functionName = cursor.next()?.value ?? ''
        if (functionName === '__construct') {
          const promoted = this.constructorParameters(docRaw)
          model.fields.push(...promoted)
          if (promoted.length > 0) model.construction = 'named'
        } else {
          if (/^(get|is|has)[A-Z]/.test(functionName)) getters++
          if (cursor.is('(')) cursor.skipGroup()
        }
        while (!cursor.done && !cursor.is('{') && !cursor.is(';')) cursor.next()
        if (cursor.is('{')) cursor.skipGroup()
        else cursor.eat(';')
        continue
      }
      // Property: [type] $name [= default];
      let type: RawType | null = null
      const typeStart = cursor.index
      if (!cursor.value().startsWith('$')) type = readType(cursor, SYNTAX)
      const typeText = cursor.textBetween(this.source, typeStart, cursor.index)
      if (!cursor.value().startsWith('$')) {
        cursor.skipUntil([';'])
        cursor.eat(';')
        continue
      }
      const nameToken = cursor.next()
      let defaultText: string | undefined
      if (cursor.eat('=')) {
        const start = cursor.index
        cursor.skipUntil([';', ','])
        defaultText = cursor.textBetween(this.source, start, cursor.index)
      }
      cursor.skipUntil([';'])
      cursor.eat(';')
      if (modifiers.has('static')) continue
      const field: RawField = { name: nameToken.value.slice(1), type: refine(type, docType(docRaw, /@var\s+([^\s*]+)/)) }
      if (typeText) field.typeText = typeText
      if (memberDoc) field.description = memberDoc
      if (defaultText !== undefined) {
        const literal = parseLiteral(defaultText)
        if (literal !== undefined) field.defaultValue = literal
        field.optional = true
      }
      if (!this.doctrine(field, memberAttributes)) continue
      model.fields.push(field)
    }
    cursor.eat('}')
    model.metadata = { accessors: getters > 0 ? 'getters' : 'properties' }
  }

  /** Doctrine mapping attributes: column names, nullability and generated ids. */
  private doctrine(field: RawField, attributes: Annotation[]): boolean {
    const normalized = attributes.map((item) => ({ ...item, name: item.name.split('\\').pop()! }))
    if (!applyAnnotations(field, normalized)) return false
    if (normalized.some((item) => item.name === 'GeneratedValue')) field.generated = true
    return true
  }

  private constructorParameters(docRaw: string | undefined): RawField[] {
    const { cursor } = this
    const fields: RawField[] = []
    if (!cursor.eat('(')) return fields
    while (!cursor.done && !cursor.is(')')) {
      const attributes: Annotation[] = []
      while (cursor.is('#[')) attributes.push(...readBracketAttributes(cursor, this.source))
      let promoted = false
      while (VISIBILITY.has(cursor.value())) {
        cursor.next()
        promoted = true
      }
      let type: RawType | null = null
      const typeStart = cursor.index
      if (!cursor.value().startsWith('$') && !cursor.is('&') && !cursor.is('...')) type = readType(cursor, SYNTAX)
      const typeText = cursor.textBetween(this.source, typeStart, cursor.index)
      cursor.eat('&')
      cursor.eat('...')
      if (!cursor.value().startsWith('$')) {
        cursor.skipUntil([','])
        cursor.eat(',')
        continue
      }
      const name = cursor.next().value.slice(1)
      let defaultText: string | undefined
      if (cursor.eat('=')) {
        const start = cursor.index
        cursor.skipUntil([','])
        defaultText = cursor.textBetween(this.source, start, cursor.index)
      }
      cursor.eat(',')
      if (!promoted) continue
      const field: RawField = { name, type: refine(type, docType(docRaw, new RegExp(`@param\\s+([^\\s*]+)\\s+\\$${name}\\b`))) }
      if (typeText) field.typeText = typeText
      if (defaultText !== undefined) {
        const literal = parseLiteral(defaultText)
        if (literal !== undefined) field.defaultValue = literal
        field.optional = true
      }
      if (this.doctrine(field, attributes)) fields.push(field)
    }
    cursor.eat(')')
    return fields
  }

  private enumDeclaration(doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const enumDef: RawEnum = { name, values: [] }
    if (this.namespace) enumDef.namespace = this.namespace
    if (doc) enumDef.description = doc
    while (!cursor.done && !cursor.is('{')) cursor.next()
    if (!cursor.eat('{')) return
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.eat('case') && cursor.isIdent()) {
        const value: RawEnum['values'][number] = { name: cursor.next().value }
        if (cursor.eat('=')) {
          const token = cursor.next()
          if (token.kind === 'string') value.value = token.value
          else if (token.kind === 'number') value.value = Number(token.value)
        }
        enumDef.values.push(value)
        cursor.skipUntil([';'])
        cursor.eat(';')
      } else if (cursor.is('{') || cursor.is('(')) cursor.skipGroup()
      else cursor.next()
    }
    cursor.eat('}')
    this.declarations.enums.push(enumDef)
  }
}

export const phpParser: InputParser = {
  id: 'php',
  kind: 'code',
  label: 'PHP',
  extensions: ['.php'],
  editorLanguage: 'php',
  detect(text) {
    if (/^\s*<\?php/.test(text)) return 0.99
    if (/\b(public|private|protected)\s+(\??[\w\\|]+\s+)?\$\w+/.test(text)) return 0.9
    return 0
  },
  parse(text) {
    if (text.trim() === '') return failure('empty')
    let tokens: Token[]
    try {
      tokens = tokenize(
        text.replace(/^\s*<\?php/, (match) => ' '.repeat(match.length)),
        LEXER,
      )
    } catch (error) {
      if (error instanceof LexError) return failure(error.code, positionAt(text, error.index))
      throw error
    }
    const reader = new Reader(text, tokens)
    reader.run()
    if (reader.declarations.models.length === 0 && reader.declarations.enums.length === 0) return failure('noModels')
    const { schema, warnings } = buildSchema(reader.declarations, PHP_TYPES, 'php', 'php')
    return { ok: true, schema, warnings }
  },
}
