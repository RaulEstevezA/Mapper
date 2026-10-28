import { primitive } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { Cursor, LexError, tokenize, type LexerConfig, type Token } from '../code/lexer.ts'
import { buildSchema, parseLiteral, type RawDeclarations, type RawField, type RawModel, type RawType, type TypeTable } from '../code/raw.ts'

const LEXER: LexerConfig = {
  lineComments: ['#'],
  blockComments: [],
  strings: [
    { open: '"""', close: '"""', escapes: false, multiline: true },
    { open: '"', close: '"', escapes: true, multiline: false },
  ],
}

export const GRAPHQL_TYPES: TypeTable = {
  primitives: {
    ID: primitive('string'),
    String: primitive('string'),
    Int: primitive('integer', 32),
    Float: primitive('float', 64),
    Boolean: primitive('boolean'),
    // Custom scalars with a conventional meaning
    DateTime: primitive('datetime'),
    Timestamp: primitive('datetime'),
    Date: primitive('date'),
    Time: primitive('time'),
    UUID: primitive('uuid'),
    Long: primitive('integer', 64),
    BigInt: primitive('integer'),
    Decimal: primitive('decimal'),
    BigDecimal: primitive('decimal'),
    JSON: primitive('any'),
    JSONObject: primitive('any'),
    Upload: primitive('binary'),
    Email: primitive('string'),
    URL: primitive('string'),
  },
  lists: [],
  maps: [],
  optionals: [],
}

/** GraphQL types are nullable unless marked with `!`; lists are `[T]`. */
function readGraphQlType(cursor: Cursor): RawType | null {
  let type: RawType
  if (cursor.eat('[')) {
    const items = readGraphQlType(cursor)
    cursor.eat(']')
    type = { name: '[]', args: items ? [items] : [] }
  } else if (cursor.isIdent()) type = { name: cursor.next().value, args: [] }
  else return null
  if (cursor.eat('!')) return type
  return { ...type, nullable: true }
}

function skipDirectives(cursor: Cursor) {
  while (cursor.is('@') && cursor.isIdent(1)) {
    cursor.next()
    cursor.next()
    if (cursor.is('(')) cursor.skipGroup()
  }
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
    while (!cursor.done) {
      // A description is a string right before the definition
      let description: string | undefined
      if (cursor.peek()?.kind === 'string') description = cursor.next().value.trim()
      const extend = cursor.eat('extend')
      const keyword = cursor.value()
      if (['type', 'input', 'interface'].includes(keyword) && cursor.isIdent(1)) {
        cursor.next()
        this.objectType(keyword, extend, description ?? cursor.tokens[cursor.index - 1].doc)
      } else if (keyword === 'enum' && cursor.isIdent(1)) {
        cursor.next()
        this.enumType(description)
      } else if (keyword === 'scalar' && cursor.isIdent(1)) {
        cursor.next()
        const name = cursor.next().value
        // A scalar the table does not know is text on the wire
        if (!(name in GRAPHQL_TYPES.primitives)) this.declarations.aliases!.set(name, { name: 'String', args: [] })
        skipDirectives(cursor)
      } else if (cursor.is('{') || cursor.is('(')) cursor.skipGroup()
      else cursor.next()
    }
  }

  private objectType(keyword: string, extend: boolean, description: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    // The operation roots describe the API, not data
    const isRoot = ['Query', 'Mutation', 'Subscription'].includes(name)
    const parents: string[] = []
    if (cursor.eat('implements')) {
      cursor.eat('&')
      while (cursor.isIdent()) {
        parents.push(cursor.next().value)
        if (!cursor.eat('&') && !cursor.eat(',')) break
      }
    }
    skipDirectives(cursor)
    const existing = this.declarations.models.find((model) => model.name === name)
    const model: RawModel =
      extend && existing
        ? existing
        : { name, kind: keyword === 'input' ? 'input' : keyword === 'interface' ? 'interface' : 'object', fields: [] }
    if (!existing || !extend) {
      if (description) model.description = description
      if (parents.length > 0) model.extends = parents
    }
    if (!cursor.eat('{')) return
    while (!cursor.done && !cursor.is('}')) {
      let fieldDescription: string | undefined
      if (cursor.peek()?.kind === 'string') fieldDescription = cursor.next().value.trim()
      if (!cursor.isIdent()) {
        cursor.next()
        continue
      }
      const nameToken = cursor.next()
      // Fields with arguments are resolvers: they compute a value from the arguments
      const hasArguments = cursor.is('(')
      if (hasArguments) cursor.skipGroup()
      cursor.eat(':')
      const typeStart = cursor.index
      const type = readGraphQlType(cursor)
      const field: RawField = { name: nameToken.value, type, typeText: cursor.textBetween(this.source, typeStart, cursor.index) }
      if (cursor.eat('=')) {
        const token = cursor.next()
        const literal = parseLiteral(token.kind === 'string' ? JSON.stringify(token.value) : token.value)
        // An enum value (`role: Role = MEMBER`) is written as a bare name
        if (literal !== undefined) field.defaultValue = literal
        else if (token.kind === 'ident') field.defaultValue = token.value
      }
      skipDirectives(cursor)
      const doc = fieldDescription ?? nameToken.doc
      if (doc) field.description = doc
      if (hasArguments) field.metadata = { arguments: true }
      model.fields.push(field)
    }
    cursor.eat('}')
    if (!isRoot && !(extend && existing)) this.declarations.models.push(model)
  }

  private enumType(description: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    skipDirectives(cursor)
    const values: { name: string; description?: string }[] = []
    if (cursor.eat('{')) {
      while (!cursor.done && !cursor.is('}')) {
        let valueDescription: string | undefined
        if (cursor.peek()?.kind === 'string') valueDescription = cursor.next().value.trim()
        if (cursor.isIdent()) values.push({ name: cursor.next().value, ...(valueDescription ? { description: valueDescription } : {}) })
        else cursor.next()
        skipDirectives(cursor)
      }
      cursor.eat('}')
    }
    this.declarations.enums.push({ name, values, ...(description ? { description } : {}) })
  }
}

export const graphQlParser: InputParser = {
  id: 'graphql',
  kind: 'schema',
  label: 'GraphQL',
  extensions: ['.graphql', '.graphqls', '.gql'],
  editorLanguage: 'graphql',
  detect(text) {
    // TypeScript writes its types in lower case (`string`, `number`); GraphQL in capitals (`String`, `Int`)
    if (/:\s*(string|number|boolean|unknown|any)\b/.test(text) || /\bexport\s/.test(text)) return 0
    if (
      /^\s*(extend\s+)?(type|input|interface)\s+\w+(\s+implements\s+[\w&\s]+)?\s*(@\w+(\([^)]*\))?\s*)*\{/m.test(text) &&
      /:\s*\[?\w+!?\]?!?/.test(text) &&
      !/[;=]\s*$/m.test(text)
    ) {
      return 0.9
    }
    if (/^\s*(scalar|enum)\s+\w+/m.test(text) && /^\s*type\s+\w+/m.test(text)) return 0.7
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
    if (reader.declarations.models.length === 0) return failure('noModels')
    const { schema, warnings } = buildSchema(reader.declarations, GRAPHQL_TYPES, 'graphql', 'graphql')
    return { ok: true, schema, warnings }
  },
}
