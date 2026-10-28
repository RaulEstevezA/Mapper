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
  ...C_LIKE,
  // Raw string literals (C# 11), verbatim and interpolated strings
  strings: [{ open: '"""', close: '"""', escapes: false, multiline: true }, ...C_LIKE.strings],
  stringPrefixes: /^(\$@|@\$|\$+|@)/,
}

const SYNTAX: TypeSyntax = { generics: '<>', arraySuffix: true, nullableSuffix: true }

export const CSHARP_TYPES: TypeTable = {
  primitives: {
    string: primitive('string'),
    String: primitive('string'),
    char: primitive('string'),
    int: primitive('integer', 32),
    Int32: primitive('integer', 32),
    uint: primitive('integer', 32),
    long: primitive('integer', 64),
    Int64: primitive('integer', 64),
    ulong: primitive('integer', 64),
    short: primitive('integer', 16),
    ushort: primitive('integer', 16),
    byte: primitive('integer', 8),
    sbyte: primitive('integer', 8),
    BigInteger: primitive('integer'),
    float: primitive('float', 32),
    Single: primitive('float', 32),
    double: primitive('float', 64),
    Double: primitive('float', 64),
    decimal: primitive('decimal'),
    Decimal: primitive('decimal'),
    bool: primitive('boolean'),
    Boolean: primitive('boolean'),
    DateTime: primitive('datetime'),
    DateTimeOffset: primitive('datetime'),
    DateOnly: primitive('date'),
    TimeOnly: primitive('time'),
    TimeSpan: primitive('duration'),
    Guid: primitive('uuid'),
    'byte[]': primitive('binary'),
    object: primitive('any'),
    dynamic: primitive('any'),
    JsonElement: primitive('any'),
    JObject: primitive('any'),
  },
  lists: [
    'List',
    'IList',
    'ICollection',
    'IEnumerable',
    'IReadOnlyList',
    'IReadOnlyCollection',
    'HashSet',
    'ISet',
    'Collection',
    'ObservableCollection',
    'ImmutableList',
    'ImmutableArray',
  ],
  maps: ['Dictionary', 'IDictionary', 'IReadOnlyDictionary', 'SortedDictionary', 'ImmutableDictionary'],
  optionals: ['Nullable'],
}

const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'readonly',
  'virtual',
  'override',
  'abstract',
  'sealed',
  'partial',
  'required',
  'new',
  'const',
  'volatile',
  'unsafe',
  'extern',
  'async',
  'file',
])

function normalize(type: RawType | null): RawType | null {
  if (!type) return null
  if (type.name === '[]' && type.args[0]?.name === 'byte') return { name: 'byte[]', args: [], nullable: type.nullable }
  return { ...type, args: type.args.map((arg) => normalize(arg)!).filter(Boolean) }
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
    while (!cursor.done) {
      if (cursor.is('using') && !cursor.is('(', 1)) {
        cursor.skipUntil([';'])
        cursor.eat(';')
        continue
      }
      if (cursor.is('namespace')) {
        cursor.next()
        const start = cursor.index
        while (!cursor.done && !cursor.is(';') && !cursor.is('{')) cursor.next()
        this.namespace = cursor.textBetween(this.source, start, cursor.index).replace(/\s+/g, '')
        // File-scoped (`namespace A;`) or block (`namespace A { … }`): declarations inside are read the same way
        cursor.next()
        continue
      }
      if (!this.declaration()) cursor.next()
    }
  }

  private declaration(): boolean {
    const { cursor } = this
    const start = cursor.index
    const doc = cursor.peek()?.doc
    const attributes: Annotation[] = []
    for (;;) {
      if (cursor.is('[')) attributes.push(...readBracketAttributes(cursor, this.source))
      else if (MODIFIERS.has(cursor.value())) cursor.next()
      else break
    }
    let keyword = cursor.value()
    if (keyword === 'record' && (cursor.is('struct', 1) || cursor.is('class', 1))) cursor.next()
    if (['class', 'struct', 'record'].includes(keyword) && cursor.isIdent(1)) {
      cursor.next()
      if (cursor.value() === 'struct' || cursor.value() === 'class') keyword = 'record'
      this.typeDeclaration(keyword, attributes, doc)
      return true
    }
    if (keyword === 'enum' && cursor.isIdent(1)) {
      cursor.next()
      this.enumDeclaration(doc)
      return true
    }
    if (keyword === 'interface' && cursor.isIdent(1)) {
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

  private typeDeclaration(keyword: string, attributes: Annotation[], doc: string | undefined) {
    const { cursor } = this
    if (cursor.is('struct') || cursor.is('class')) cursor.next()
    const name = cursor.next().value
    const model: RawModel = {
      name,
      kind: keyword === 'record' ? 'record' : keyword === 'struct' ? 'struct' : 'class',
      fields: [],
      generics: this.typeParameters(),
      construction: 'properties',
    }
    if (this.namespace) model.namespace = this.namespace
    if (doc) model.description = doc
    if (attributes.length > 0) model.annotations = attributes
    if (cursor.is('(')) {
      model.fields = this.parameters()
      model.construction = 'positional'
    }
    const parents: string[] = []
    if (cursor.eat(':')) {
      do {
        const parent = readType(cursor, SYNTAX)
        if (parent) parents.push(parent.name.split('.').pop()!)
        if (cursor.is('(')) cursor.skipGroup()
      } while (cursor.eat(','))
    }
    model.extends = parents
    while (!cursor.done && !cursor.is('{') && !cursor.is(';')) cursor.next()
    if (parents.includes('DbContext') || parents.includes('IdentityDbContext')) {
      // The context lists the tables (DbSet<User>); it is not a model itself
      cursor.skipGroup()
      return
    }
    if (attributes.some((item) => item.name === 'Table' || item.name === 'Index' || item.name === 'PrimaryKey')) {
      model.kind = 'entity'
      model.framework = 'efcore'
    }
    this.declarations.models.push(model)
    if (cursor.eat(';')) return
    model.fields.push(...this.body(name))
    if (model.fields.some((field) => field.annotations?.some((item) => item.name === 'Key' || item.name === 'ForeignKey'))) {
      model.kind = 'entity'
      model.framework = 'efcore'
    }
  }

  /** Positional record parameters: `record User(int Id, [property: JsonPropertyName("n")] string Name)`. */
  private parameters(): RawField[] {
    const { cursor } = this
    const fields: RawField[] = []
    cursor.next()
    while (!cursor.done && !cursor.is(')')) {
      const attributes: Annotation[] = []
      while (cursor.is('[')) attributes.push(...readBracketAttributes(cursor, this.source))
      const typeStart = cursor.index
      const type = normalize(readType(cursor, SYNTAX))
      const typeText = cursor.textBetween(this.source, typeStart, cursor.index)
      if (!cursor.isIdent()) {
        cursor.skipUntil([','])
        cursor.eat(',')
        continue
      }
      const field: RawField = { name: cursor.next().value, type, typeText }
      if (cursor.eat('=')) {
        const start = cursor.index
        cursor.skipUntil([','])
        const literal = parseLiteral(cursor.textBetween(this.source, start, cursor.index))
        if (literal !== undefined) field.defaultValue = literal
        field.optional = true
      }
      if (applyAnnotations(field, attributes)) fields.push(field)
      cursor.eat(',')
    }
    cursor.eat(')')
    return fields
  }

  private body(owner: string): RawField[] {
    const { cursor } = this
    const fields: RawField[] = []
    if (!cursor.eat('{')) return fields
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.eat(';')) continue
      const memberStart = cursor.index
      if (this.declaration()) continue
      cursor.index = memberStart
      const doc = cursor.peek()?.doc
      const attributes: Annotation[] = []
      const modifiers = new Set<string>()
      for (;;) {
        if (cursor.is('[')) attributes.push(...readBracketAttributes(cursor, this.source))
        else if (MODIFIERS.has(cursor.value())) modifiers.add(cursor.next().value)
        else break
      }
      if ((cursor.is(owner) || cursor.is('~')) && (cursor.is('(', 1) || cursor.is(owner, 1))) {
        this.skipMember()
        continue
      }
      if (cursor.is('event') || cursor.is('delegate') || cursor.is('operator') || cursor.is('implicit') || cursor.is('explicit')) {
        this.skipMember()
        continue
      }
      const typeStart = cursor.index
      const type = normalize(readType(cursor, SYNTAX))
      const typeText = cursor.textBetween(this.source, typeStart, cursor.index)
      if (!type || !cursor.isIdent()) {
        this.skipMember()
        continue
      }
      const nameToken = cursor.next()
      if (cursor.is('(') || cursor.is('<') || cursor.is('.')) {
        cursor.index--
        this.skipMember()
        continue
      }
      const field: RawField = { name: nameToken.value, type, typeText }
      if (doc) field.description = doc
      let computed = false
      let accessors = false
      if (cursor.is('{')) {
        accessors = true
        // Property accessors: `{ get; set; }`, `{ get; init; }`, `{ get => _x; }`
        const accessorsStart = cursor.index
        cursor.skipGroup()
        const text = cursor.textBetween(this.source, accessorsStart, cursor.index)
        if (!/\b(set|init)\b/.test(text) || /\bget\s*(=>|\{)/.test(text)) computed = true
      } else if (cursor.is('=>')) {
        computed = true
      }
      const initialized = cursor.eat('=')
      if (initialized) {
        const start = cursor.index
        cursor.skipUntil([';'])
        const text = cursor.textBetween(this.source, start, cursor.index)
        const literal = parseLiteral(text)
        // `= null!` and `= default!` only silence the compiler: they are not real defaults
        if (literal !== undefined && literal !== null) field.defaultValue = literal
        if (!/^(null|default)!$/.test(text.trim()) && !modifiers.has('required')) field.optional = true
      }
      // A property's accessors end it, unless an initializer follows
      if (!accessors || initialized) this.skipMember()
      if (modifiers.has('static') || modifiers.has('const') || computed) continue
      // Members are private unless declared otherwise: only the public surface is the model
      if (!modifiers.has('public') && !modifiers.has('internal')) continue
      if (!applyAnnotations(field, attributes)) continue
      // Entity Framework fills in an integer key called Id or <Class>Id
      if (attributes.some((item) => item.name === 'DatabaseGenerated' && /Identity|Computed/.test(item.args ?? ''))) field.generated = true
      fields.push(field)
    }
    cursor.eat('}')
    return fields
  }

  /** Skips the rest of a member: up to `;` or the end of its body. */
  private skipMember() {
    const { cursor } = this
    while (!cursor.done && !cursor.is(';') && !cursor.is('}')) {
      if (cursor.is('{') || cursor.is('(') || cursor.is('[')) {
        const wasBody = cursor.is('{')
        cursor.skipGroup()
        // A method body ends the member unless an initializer follows (`{ get; } = 5;`)
        if (wasBody && !cursor.is('=')) return
        continue
      }
      cursor.next()
    }
    cursor.eat(';')
  }

  private enumDeclaration(doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const enumDef: RawEnum = { name, values: [] }
    if (this.namespace) enumDef.namespace = this.namespace
    if (doc) enumDef.description = doc
    while (!cursor.done && !cursor.is('{')) cursor.next()
    if (!cursor.eat('{')) return
    let next = 0
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.is('[')) {
        readBracketAttributes(cursor, this.source)
        continue
      }
      if (!cursor.isIdent()) {
        cursor.next()
        continue
      }
      const value: RawEnum['values'][number] = { name: cursor.next().value }
      if (cursor.eat('=')) {
        const token = cursor.next()
        if (token?.kind === 'number') next = Number(token.value)
        cursor.skipUntil([','])
      }
      value.value = next++
      enumDef.values.push(value)
      cursor.eat(',')
    }
    cursor.eat('}')
    this.declarations.enums.push(enumDef)
  }
}

export const cSharpParser: InputParser = {
  id: 'csharp',
  kind: 'code',
  label: 'C#',
  extensions: ['.cs'],
  editorLanguage: 'csharp',
  detect(text) {
    if (/\{\s*get;\s*(set|init);?\s*\}/.test(text)) return 0.95
    if (/^\s*namespace\s+[\w.]+\s*[;{]/m.test(text) || /^\s*using\s+System/m.test(text)) return 0.9
    if (/\b(public\s+)?(sealed\s+)?record\s+\w+\s*\(/.test(text) && /\b(string|int|Guid|DateTime|decimal)\b/.test(text)) return 0.7
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
    const { schema, warnings } = buildSchema(reader.declarations, CSHARP_TYPES, 'csharp', 'csharp')
    return { ok: true, schema, warnings }
  },
}
