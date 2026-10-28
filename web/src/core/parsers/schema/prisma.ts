import { primitive } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { C_LIKE, Cursor, LexError, tokenize, type Token } from '../code/lexer.ts'
import { annotationArg } from '../code/annotations.ts'
import { buildSchema, parseLiteral, type RawDeclarations, type RawField, type RawModel, type RawType, type TypeTable } from '../code/raw.ts'

export const PRISMA_TYPES: TypeTable = {
  primitives: {
    String: primitive('string'),
    Int: primitive('integer', 32),
    BigInt: primitive('integer', 64),
    Float: primitive('float', 64),
    Decimal: primitive('decimal'),
    Boolean: primitive('boolean'),
    DateTime: primitive('datetime'),
    Json: primitive('any'),
    Bytes: primitive('binary'),
    Unsupported: primitive('any'),
  },
  lists: [],
  maps: [],
  optionals: [],
}

// Defaults computed by the database or Prisma: the value is never needed from a mapping
const GENERATED_DEFAULTS = /^(autoincrement|now|uuid|cuid|nanoid|ulid|dbgenerated|sequence)\(/

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
      if ((cursor.is('model') || cursor.is('view') || cursor.is('type')) && cursor.isIdent(1) && cursor.is('{', 2)) {
        cursor.next()
        this.model()
      } else if (cursor.is('enum') && cursor.isIdent(1)) {
        cursor.next()
        this.enumDeclaration()
      } else if (cursor.is('{')) cursor.skipGroup()
      else cursor.next()
    }
  }

  private model() {
    const { cursor } = this
    const doc = cursor.tokens[cursor.index - 1]?.doc
    const name = cursor.next().value
    const model: RawModel = { name, kind: 'table', fields: [], framework: 'prisma', construction: 'named' }
    if (doc) model.description = doc
    cursor.next()
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.is('@') && cursor.is('@', 1)) {
        // Block attributes (@@map, @@id, @@index)
        const line = cursor.peek()!.line
        while (!cursor.done && cursor.peek()!.line === line && !cursor.is('}')) cursor.next()
        continue
      }
      if (!cursor.isIdent()) {
        cursor.next()
        continue
      }
      const fieldToken = cursor.next()
      const line = fieldToken.line
      if (!cursor.isIdent()) continue
      let type: RawType = { name: cursor.next().value, args: [] }
      if (cursor.is('(') && type.name === 'Unsupported') cursor.skipGroup()
      if (cursor.is('[') && cursor.is(']', 1)) {
        cursor.next()
        cursor.next()
        type = { name: '[]', args: [type] }
      }
      const field: RawField = {
        name: fieldToken.value,
        type,
        typeText: cursor.textBetween(this.source, cursor.tokens.indexOf(fieldToken) + 1, cursor.index),
      }
      if (cursor.eat('?')) field.nullable = true
      // Field attributes until the end of the line
      while (!cursor.done && cursor.peek()!.line === line && !cursor.is('}')) {
        if (cursor.is('@') && cursor.isIdent(1)) {
          cursor.next()
          let attribute = cursor.next().value
          while (cursor.is('.') && cursor.isIdent(1)) {
            cursor.next()
            attribute += `.${cursor.next().value}`
          }
          let args = ''
          if (cursor.is('(')) {
            const start = cursor.index
            cursor.skipGroup()
            args = cursor.textBetween(this.source, start, cursor.index).slice(1, -1).trim()
          }
          field.annotations = [...(field.annotations ?? []), { name: attribute, args }]
          if (attribute === 'default') {
            field.optional = true
            if (GENERATED_DEFAULTS.test(args)) field.generated = true
            else {
              const literal = parseLiteral(args)
              if (literal !== undefined) field.defaultValue = literal
              else if (/^\w+$/.test(args)) field.defaultValue = args
            }
          }
          if (attribute === 'updatedAt') field.generated = true
          if (attribute === 'map') {
            const column = annotationArg({ name: 'map', args }, null) ?? annotationArg({ name: 'map', args }, 'name')
            if (column) field.serializedName = column
          }
          if (attribute === 'relation') field.metadata = { relation: true }
        } else cursor.next()
      }
      if (fieldToken.doc) field.description = fieldToken.doc
      model.fields.push(field)
    }
    cursor.eat('}')
    this.declarations.models.push(model)
  }

  private enumDeclaration() {
    const { cursor } = this
    const name = cursor.next().value
    const values: { name: string; value?: string }[] = []
    if (cursor.eat('{')) {
      while (!cursor.done && !cursor.is('}')) {
        if (cursor.is('@')) {
          cursor.next()
          cursor.eat('@')
          const attribute = cursor.next()
          if (attribute?.value === 'map' && cursor.is('(') && cursor.peek(1)?.kind === 'string' && values.length > 0)
            values[values.length - 1].value = cursor.peek(1)!.value
          if (cursor.is('(')) cursor.skipGroup()
          continue
        }
        if (cursor.isIdent()) values.push({ name: cursor.next().value })
        else cursor.next()
      }
      cursor.eat('}')
    }
    this.declarations.enums.push({ name, values })
  }
}

export const prismaParser: InputParser = {
  id: 'prisma',
  kind: 'schema',
  label: 'Prisma',
  extensions: ['.prisma'],
  editorLanguage: 'prisma',
  detect(text) {
    if (/^\s*(generator|datasource)\s+\w+\s*\{/m.test(text)) return 0.99
    return /^\s*model\s+\w+\s*\{/m.test(text) && /@(id|default|unique|relation)\b/.test(text) ? 0.95 : 0
  },
  parse(text) {
    if (text.trim() === '') return failure('empty')
    let tokens: Token[]
    try {
      tokens = tokenize(text, C_LIKE)
    } catch (error) {
      if (error instanceof LexError) return failure(error.code, positionAt(text, error.index))
      throw error
    }
    const reader = new Reader(text, tokens)
    reader.run()
    if (reader.declarations.models.length === 0) return failure('noModels')
    const { schema, warnings } = buildSchema(reader.declarations, PRISMA_TYPES, 'prisma', 'prisma')
    return { ok: true, schema, warnings }
  },
}
