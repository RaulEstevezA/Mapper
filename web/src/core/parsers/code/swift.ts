import { primitive } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { Cursor, LexError, tokenize, type LexerConfig, type Token } from './lexer.ts'
import { buildSchema, parseLiteral, type RawDeclarations, type RawEnum, type RawField, type RawModel, type TypeTable } from './raw.ts'
import { readType, type TypeSyntax } from './typeSyntax.ts'

const LEXER: LexerConfig = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  nestedComments: true,
  strings: [
    { open: '"""', close: '"""', escapes: true, multiline: true },
    { open: '"', close: '"', escapes: true, multiline: false },
  ],
}

const SYNTAX: TypeSyntax = { generics: '<>', nullableSuffix: true, bracketCollections: true }

export const SWIFT_TYPES: TypeTable = {
  primitives: {
    String: primitive('string'),
    Character: primitive('string'),
    Substring: primitive('string'),
    Int: primitive('integer', 64),
    Int64: primitive('integer', 64),
    Int32: primitive('integer', 32),
    Int16: primitive('integer', 16),
    Int8: primitive('integer', 8),
    UInt: primitive('integer', 64),
    UInt64: primitive('integer', 64),
    UInt32: primitive('integer', 32),
    Double: primitive('float', 64),
    Float: primitive('float', 32),
    CGFloat: primitive('float', 64),
    Decimal: primitive('decimal'),
    Bool: primitive('boolean'),
    Date: primitive('datetime'),
    UUID: primitive('uuid'),
    Data: primitive('binary'),
    URL: primitive('string'),
    TimeInterval: primitive('duration'),
    Any: primitive('any'),
    AnyHashable: primitive('any'),
  },
  lists: ['Array', 'Set', 'ContiguousArray'],
  maps: ['Dictionary'],
  optionals: ['Optional'],
}

const MODIFIERS = new Set([
  'public',
  'private',
  'fileprivate',
  'internal',
  'open',
  'final',
  'static',
  'class',
  'lazy',
  'weak',
  'unowned',
  'override',
  'mutating',
  'nonmutating',
  'indirect',
  'required',
  'convenience',
  'dynamic',
  'nonisolated',
])

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
    while (!cursor.done) {
      if (!this.declaration()) {
        if (cursor.is('{')) cursor.skipGroup()
        else cursor.next()
      }
    }
  }

  private skipAttributes() {
    const { cursor } = this
    while (cursor.is('@') && cursor.isIdent(1)) {
      cursor.next()
      cursor.next()
      if (cursor.is('(')) cursor.skipGroup()
    }
  }

  private declaration(): boolean {
    const { cursor } = this
    const start = cursor.index
    const doc = cursor.peek()?.doc
    this.skipAttributes()
    while (MODIFIERS.has(cursor.value()) && !(cursor.is('class') && cursor.isIdent(1) && !MODIFIERS.has(cursor.value(1)))) cursor.next()
    const keyword = cursor.value()
    if ((keyword === 'struct' || keyword === 'class' || keyword === 'actor') && cursor.isIdent(1)) {
      cursor.next()
      this.typeDeclaration(keyword, doc)
      return true
    }
    if (keyword === 'enum' && cursor.isIdent(1)) {
      cursor.next()
      this.enumDeclaration(doc)
      return true
    }
    if (keyword === 'typealias' && cursor.isIdent(1) && cursor.is('=', 2)) {
      cursor.next()
      const name = cursor.next().value
      cursor.next()
      const type = readType(cursor, SYNTAX)
      if (type) this.declarations.aliases!.set(name, type)
      return true
    }
    if ((keyword === 'protocol' || keyword === 'extension') && cursor.isIdent(1)) {
      while (!cursor.done && !cursor.is('{')) cursor.next()
      cursor.skipGroup()
      return true
    }
    cursor.index = start
    return false
  }

  private typeDeclaration(keyword: string, doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const generics: string[] = []
    if (cursor.is('<')) {
      cursor.next()
      while (!cursor.done && !cursor.is('>')) {
        if (cursor.isIdent() && ['<', ','].includes(cursor.tokens[cursor.index - 1].value)) generics.push(cursor.value())
        cursor.next()
      }
      cursor.eat('>')
    }
    const model: RawModel = { name, kind: keyword === 'struct' ? 'struct' : 'class', fields: [], generics, construction: 'named' }
    if (doc) model.description = doc
    const conformances: string[] = []
    if (cursor.eat(':')) {
      do {
        const type = readType(cursor, SYNTAX)
        if (type) conformances.push(type.name)
      } while (cursor.eat(','))
    }
    while (!cursor.done && !cursor.is('{')) cursor.next()
    if (conformances.some((item) => ['Codable', 'Decodable', 'Encodable'].includes(item))) model.framework = 'codable'
    // A class inherits from its first conformance when it is a class of the input
    model.extends = keyword === 'class' && conformances[0] ? [conformances[0]] : []
    this.declarations.models.push(model)
    model.fields = this.body()
  }

  private body(): RawField[] {
    const { cursor } = this
    const fields: RawField[] = []
    const codingKeys = new Map<string, string>()
    if (!cursor.eat('{')) return fields
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.eat(';')) continue
      // CodingKeys: the names used in JSON
      if (cursor.is('enum') && cursor.is('CodingKeys', 1)) {
        cursor.next()
        cursor.next()
        while (!cursor.done && !cursor.is('{')) cursor.next()
        cursor.next()
        while (!cursor.done && !cursor.is('}')) {
          if (cursor.eat('case')) {
            do {
              const key = cursor.next().value
              if (cursor.eat('=')) {
                const wire = cursor.next()
                codingKeys.set(key, wire.value)
              } else codingKeys.set(key, key)
            } while (cursor.eat(','))
          } else cursor.next()
        }
        cursor.eat('}')
        continue
      }
      const memberStart = cursor.index
      if (this.declaration()) continue
      cursor.index = memberStart
      const doc = cursor.peek()?.doc
      this.skipAttributes()
      const modifiers = new Set<string>()
      while (MODIFIERS.has(cursor.value()) || (cursor.is('private') && cursor.is('(', 1))) {
        modifiers.add(cursor.next().value)
        // private(set) still exposes the getter
        if (cursor.is('(')) cursor.skipGroup()
      }
      if (!(cursor.is('let') || cursor.is('var'))) {
        this.skipMember()
        continue
      }
      const isLet = cursor.next().value === 'let'
      if (!cursor.isIdent()) {
        this.skipMember()
        continue
      }
      const name = cursor.next().value
      let type = null
      let typeText: string | undefined
      if (cursor.eat(':')) {
        const typeStart = cursor.index
        type = readType(cursor, SYNTAX)
        typeText = cursor.textBetween(this.source, typeStart, cursor.index)
      }
      let defaultValue: string | undefined
      if (cursor.eat('=')) {
        const start = cursor.index
        this.skipToLineEnd()
        defaultValue = cursor.textBetween(this.source, start, cursor.index)
      }
      // `var x: Int { … }` is computed; `{ didSet { … } }` observes a stored property
      let computed = false
      if (cursor.is('{')) {
        const blockStart = cursor.index
        cursor.skipGroup()
        const block = cursor.textBetween(this.source, blockStart, cursor.index)
        computed = !/^\{\s*(willSet|didSet)\b/.test(block)
      }
      if (computed || modifiers.has('static') || modifiers.has('class') || modifiers.has('private') || modifiers.has('fileprivate'))
        continue
      const field: RawField = { name, type }
      if (typeText) field.typeText = typeText
      if (doc) field.description = doc
      if (defaultValue !== undefined) {
        const literal = parseLiteral(defaultValue)
        if (literal !== undefined) field.defaultValue = literal
        // A `let` with a value is a constant: the memberwise initializer does not take it
        if (isLet) continue
        field.optional = true
        if (!type && literal !== undefined && literal !== null) {
          field.type = {
            name:
              typeof literal === 'string' ? 'String' : typeof literal === 'boolean' ? 'Bool' : Number.isInteger(literal) ? 'Int' : 'Double',
            args: [],
          }
        }
      }
      if (!field.type) continue
      fields.push(field)
    }
    cursor.eat('}')
    if (codingKeys.size > 0) {
      // Only the properties listed in CodingKeys are encoded
      const kept = fields.filter((field) => codingKeys.has(field.name))
      for (const field of kept) {
        const wire = codingKeys.get(field.name)!
        if (wire !== field.name) field.serializedName = wire
      }
      return kept
    }
    return fields
  }

  private skipToLineEnd() {
    const { cursor } = this
    const start = cursor.index
    let depth = 0
    while (!cursor.done) {
      const token = cursor.peek()!
      if (cursor.index > start && depth === 0 && (token.lineStart || cursor.is(';') || cursor.is('}'))) return
      if (token.kind === 'punct' && '([{'.includes(token.value)) {
        // A trailing `{` on the same line after the value is an accessor block only if a newline came first
        if (token.value === '{' && depth === 0 && cursor.index > start) return
        depth++
      } else if (token.kind === 'punct' && ')]}'.includes(token.value)) depth--
      cursor.next()
    }
  }

  private skipMember() {
    const { cursor } = this
    const start = cursor.index
    while (!cursor.done) {
      if (cursor.index > start && cursor.peek()!.lineStart) return
      if (cursor.is('}')) return
      if (cursor.is('{') || cursor.is('(') || cursor.is('[')) {
        const wasBody = cursor.is('{')
        cursor.skipGroup()
        if (wasBody) return
        continue
      }
      cursor.next()
    }
  }

  private enumDeclaration(doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const enumDef: RawEnum = { name, values: [] }
    if (doc) enumDef.description = doc
    let rawType = ''
    if (cursor.eat(':')) rawType = cursor.value()
    while (!cursor.done && !cursor.is('{')) cursor.next()
    if (!cursor.eat('{')) return
    let next = 0
    while (!cursor.done && !cursor.is('}')) {
      if (!cursor.eat('case')) {
        if (cursor.is('{')) cursor.skipGroup()
        else if (this.declaration()) continue
        else cursor.next()
        continue
      }
      do {
        if (!cursor.isIdent()) break
        const value: RawEnum['values'][number] = { name: cursor.next().value }
        if (cursor.is('(')) cursor.skipGroup()
        if (cursor.eat('=')) {
          const token = cursor.next()
          if (token.kind === 'string') value.value = token.value
          else if (token.kind === 'number') {
            value.value = Number(token.value)
            next = value.value + 1
          }
        } else if (rawType === 'Int') value.value = next++
        enumDef.values.push(value)
      } while (cursor.eat(','))
    }
    cursor.eat('}')
    this.declarations.enums.push(enumDef)
  }
}

export const swiftParser: InputParser = {
  id: 'swift',
  kind: 'code',
  label: 'Swift',
  extensions: ['.swift'],
  editorLanguage: 'swift',
  detect(text) {
    if (/\bstruct\s+\w+\s*:\s*[\w, ]*(Codable|Decodable|Encodable|Hashable|Identifiable)/.test(text)) return 0.95
    if (/^\s*import\s+(Foundation|SwiftUI|UIKit)\s*$/m.test(text)) return 0.95
    if (
      /\b(let|var)\s+\w+\s*:\s*\[?[A-Z]\w*\]?\??\s*$/m.test(text) &&
      /\b(struct|class)\s+\w+/.test(text) &&
      !/\bdata\s+class\b/.test(text)
    )
      return 0.7
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
    const { schema, warnings } = buildSchema(reader.declarations, SWIFT_TYPES, 'swift', 'swift')
    return { ok: true, schema, warnings }
  },
}
