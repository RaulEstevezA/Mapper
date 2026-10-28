import { primitive } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { C_LIKE, Cursor, LexError, tokenize, type Token } from '../code/lexer.ts'
import { buildSchema, type RawDeclarations, type RawEnum, type RawField, type RawModel, type RawType, type TypeTable } from '../code/raw.ts'

export const PROTOBUF_TYPES: TypeTable = {
  primitives: {
    string: primitive('string'),
    bytes: primitive('binary'),
    bool: primitive('boolean'),
    double: primitive('float', 64),
    float: primitive('float', 32),
    int32: primitive('integer', 32),
    sint32: primitive('integer', 32),
    sfixed32: primitive('integer', 32),
    uint32: primitive('integer', 32),
    fixed32: primitive('integer', 32),
    int64: primitive('integer', 64),
    sint64: primitive('integer', 64),
    sfixed64: primitive('integer', 64),
    uint64: primitive('integer', 64),
    fixed64: primitive('integer', 64),
    'google.protobuf.Timestamp': primitive('datetime'),
    'google.protobuf.Duration': primitive('duration'),
    'google.protobuf.Any': primitive('any'),
    'google.protobuf.Struct': primitive('any'),
    'google.protobuf.Value': primitive('any'),
    'google.type.Date': primitive('date'),
    'google.type.Money': primitive('decimal'),
  },
  // Wrapper types exist to make a scalar nullable
  nullablePrimitives: {
    'google.protobuf.StringValue': primitive('string'),
    'google.protobuf.BytesValue': primitive('binary'),
    'google.protobuf.BoolValue': primitive('boolean'),
    'google.protobuf.DoubleValue': primitive('float', 64),
    'google.protobuf.FloatValue': primitive('float', 32),
    'google.protobuf.Int32Value': primitive('integer', 32),
    'google.protobuf.UInt32Value': primitive('integer', 32),
    'google.protobuf.Int64Value': primitive('integer', 64),
    'google.protobuf.UInt64Value': primitive('integer', 64),
  },
  lists: [],
  maps: [],
  optionals: [],
}

const SCALARS = new Set(Object.keys(PROTOBUF_TYPES.primitives).filter((name) => !name.includes('.')))

class Reader {
  readonly cursor: Cursor
  readonly declarations: RawDeclarations = { models: [], enums: [], warnings: [] }
  private proto3 = false
  private namespace: string | undefined
  /** Enums declared anywhere in the file, also after the messages that use them */
  private readonly enumNames: Set<string>

  constructor(tokens: Token[]) {
    this.cursor = new Cursor(tokens)
    this.enumNames = new Set(
      tokens.filter((token, index) => tokens[index - 1]?.value === 'enum' && token.kind === 'ident').map((token) => token.value),
    )
  }

  private qualifiedName(): string {
    const { cursor } = this
    // A leading dot means a fully qualified name (`.google.protobuf.Timestamp`)
    cursor.eat('.')
    let name = cursor.next().value
    while (cursor.is('.') && cursor.isIdent(1)) {
      cursor.next()
      name += `.${cursor.next().value}`
    }
    return name
  }

  run() {
    const { cursor } = this
    while (!cursor.done) {
      if (cursor.is('syntax') || cursor.is('edition')) {
        cursor.next()
        cursor.eat('=')
        this.proto3 = cursor.peek()?.value === 'proto3' || cursor.peek()?.value !== 'proto2'
        cursor.skipUntil([';'])
        cursor.eat(';')
      } else if (cursor.is('package')) {
        cursor.next()
        this.namespace = this.qualifiedName()
        cursor.eat(';')
      } else if (cursor.is('message') && cursor.isIdent(1)) {
        cursor.next()
        this.message()
      } else if (cursor.is('enum') && cursor.isIdent(1)) {
        cursor.next()
        this.enumDeclaration()
      } else if (cursor.is('service') || cursor.is('extend')) {
        while (!cursor.done && !cursor.is('{')) cursor.next()
        cursor.skipGroup()
      } else if (cursor.is('{')) cursor.skipGroup()
      else cursor.next()
    }
  }

  private message() {
    const { cursor } = this
    const doc = cursor.peek()?.doc ?? cursor.tokens[cursor.index - 1]?.doc
    const name = cursor.next().value
    const model: RawModel = { name, kind: 'message', fields: [], construction: 'properties' }
    if (this.namespace) model.namespace = this.namespace
    if (doc) model.description = doc
    this.declarations.models.push(model)
    if (!cursor.eat('{')) return
    this.fields(model)
  }

  private fields(model: RawModel, inOneof = false) {
    const { cursor } = this
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.eat(';')) continue
      if (cursor.is('message') && cursor.isIdent(1)) {
        cursor.next()
        this.message()
        continue
      }
      if (cursor.is('enum') && cursor.isIdent(1)) {
        cursor.next()
        this.enumDeclaration()
        continue
      }
      if (cursor.is('oneof') && cursor.isIdent(1)) {
        // Only one field of a oneof is set: all of them are optional
        cursor.next()
        cursor.next()
        cursor.eat('{')
        this.fields(model, true)
        continue
      }
      if (['option', 'reserved', 'extensions', 'extend'].includes(cursor.value())) {
        if (cursor.is('extend')) {
          while (!cursor.done && !cursor.is('{')) cursor.next()
          cursor.skipGroup()
        } else {
          cursor.skipUntil([';'])
          cursor.eat(';')
        }
        continue
      }
      const doc = cursor.peek()?.doc
      let label = ''
      if (['optional', 'repeated', 'required'].includes(cursor.value()) && (cursor.isIdent(1) || cursor.is('.', 1)))
        label = cursor.next().value
      let type: RawType
      if (cursor.is('map') && cursor.is('<', 1)) {
        cursor.next()
        cursor.next()
        const key = this.qualifiedName()
        cursor.eat(',')
        const value = this.qualifiedName()
        cursor.eat('>')
        type = {
          name: '{}',
          args: [
            { name: key, args: [] },
            { name: value, args: [] },
          ],
        }
      } else if (cursor.isIdent() || cursor.is('.')) {
        const typeName = this.qualifiedName()
        // References to nested messages may be qualified (`Order.Line`): the last part names the model
        type = { name: SCALARS.has(typeName) || typeName.startsWith('google.') ? typeName : typeName.split('.').pop()!, args: [] }
      } else {
        cursor.next()
        continue
      }
      if (!cursor.isIdent()) {
        cursor.skipUntil([';'])
        cursor.eat(';')
        continue
      }
      const name = cursor.next().value
      let deprecated = false
      cursor.skipUntil([';', '['])
      if (cursor.is('[')) {
        const start = cursor.index
        cursor.skipGroup()
        deprecated = cursor.tokens.slice(start, cursor.index).some((token) => token.value === 'deprecated')
      }
      cursor.eat(';')
      if (label === 'repeated') type = { name: '[]', args: [type] }
      const isScalar = SCALARS.has(type.name) || type.name === '{}' || type.name === '[]'
      const field: RawField = { name, type }
      // proto3: scalars always have a value (their default); messages and `optional` fields may be absent
      if (label === 'optional' || inOneof || (!this.proto3 && label !== 'required')) {
        field.optional = true
        field.nullable = true
      } else if (!isScalar && !this.isEnum(type.name)) {
        field.optional = true
        field.nullable = true
      }
      if (doc) field.description = doc
      if (deprecated) field.metadata = { deprecated: true }
      model.fields.push(field)
    }
    cursor.eat('}')
  }

  private isEnum(name: string): boolean {
    return this.enumNames.has(name)
  }

  private enumDeclaration() {
    const { cursor } = this
    const doc = cursor.tokens[cursor.index - 1]?.doc
    const name = cursor.next().value
    const enumDef: RawEnum = { name, values: [] }
    if (doc) enumDef.description = doc
    if (!cursor.eat('{')) return
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.is('option') || cursor.is('reserved')) {
        cursor.skipUntil([';'])
        cursor.eat(';')
        continue
      }
      if (cursor.isIdent() && cursor.is('=', 1)) {
        const valueName = cursor.next().value
        cursor.next()
        const negative = cursor.eat('-')
        const number = cursor.next()
        enumDef.values.push({ name: valueName, value: (negative ? -1 : 1) * Number(number.value) })
        cursor.skipUntil([';'])
        cursor.eat(';')
        continue
      }
      cursor.next()
    }
    cursor.eat('}')
    this.declarations.enums.push(enumDef)
  }
}

export const protobufParser: InputParser = {
  id: 'protobuf',
  kind: 'schema',
  label: 'Protocol Buffers',
  extensions: ['.proto'],
  editorLanguage: 'protobuf',
  detect(text) {
    if (/^\s*syntax\s*=\s*["']proto[23]["']/m.test(text)) return 0.99
    return /^\s*message\s+\w+\s*\{/m.test(text) && /=\s*\d+\s*;/.test(text) ? 0.9 : 0
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
    const reader = new Reader(tokens)
    reader.run()
    if (reader.declarations.models.length === 0) return failure('noModels')
    const { schema, warnings } = buildSchema(reader.declarations, PROTOBUF_TYPES, 'protobuf', 'protobuf')
    return { ok: true, schema, warnings }
  },
}
