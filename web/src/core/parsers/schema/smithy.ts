import { primitive, type Annotation } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { C_LIKE, Cursor, LexError, tokenize, type Token } from '../code/lexer.ts'
import { annotationArg } from '../code/annotations.ts'
import { buildSchema, parseLiteral, type RawDeclarations, type RawEnum, type RawField, type TypeTable } from '../code/raw.ts'

export const SMITHY_TYPES: TypeTable = {
  primitives: {
    String: primitive('string'),
    Boolean: primitive('boolean'),
    PrimitiveBoolean: primitive('boolean'),
    Byte: primitive('integer', 8),
    Short: primitive('integer', 16),
    Integer: primitive('integer', 32),
    PrimitiveInteger: primitive('integer', 32),
    Long: primitive('integer', 64),
    PrimitiveLong: primitive('integer', 64),
    BigInteger: primitive('integer'),
    Float: primitive('float', 32),
    Double: primitive('float', 64),
    PrimitiveDouble: primitive('float', 64),
    BigDecimal: primitive('decimal'),
    Timestamp: primitive('datetime'),
    Blob: primitive('binary'),
    Document: primitive('any'),
  },
  lists: [],
  maps: [],
  optionals: [],
}

/** Traits before a shape or member: `@required`, `@jsonName("x")`, `@documentation("…")`. */
function readTraits(cursor: Cursor, source: string): Annotation[] {
  const traits: Annotation[] = []
  while (cursor.is('@') && cursor.isIdent(1)) {
    cursor.next()
    let name = cursor.next().value
    while ((cursor.is('.') || cursor.is('#')) && cursor.isIdent(1)) {
      cursor.next()
      name = cursor.next().value
    }
    const trait: Annotation = { name }
    if (cursor.is('(')) {
      const start = cursor.index
      cursor.skipGroup()
      trait.args = cursor.textBetween(source, start, cursor.index).slice(1, -1).trim()
    }
    traits.push(trait)
  }
  return traits
}

function documentation(traits: Annotation[], token: Token | undefined): string | undefined {
  const trait = traits.find((item) => item.name === 'documentation')
  return (trait ? annotationArg(trait, null) : undefined) ?? token?.doc
}

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
      if (cursor.is('namespace') && cursor.isIdent(1)) {
        cursor.next()
        let name = cursor.next().value
        while (cursor.is('.') && cursor.isIdent(1)) {
          cursor.next()
          name += `.${cursor.next().value}`
        }
        this.namespace = name
        continue
      }
      const first = cursor.peek()
      const traits = readTraits(cursor, this.source)
      const keyword = cursor.value()
      if (['structure', 'list', 'set', 'map', 'enum', 'intEnum', 'union'].includes(keyword) && cursor.isIdent(1)) {
        cursor.next()
        const name = cursor.next().value
        // Mixins and resources: `structure A with [B]`
        while (!cursor.done && !cursor.is('{')) cursor.next()
        if (keyword === 'structure') this.structure(name, documentation(traits, first))
        else if (keyword === 'enum' || keyword === 'intEnum') this.enumShape(name, documentation(traits, first))
        else this.collection(keyword, name)
      } else if (cursor.is('{')) cursor.skipGroup()
      else cursor.next()
    }
  }

  private members(): { name: string; target: string; traits: Annotation[]; token: Token; defaultText?: string }[] {
    const { cursor } = this
    const members: { name: string; target: string; traits: Annotation[]; token: Token; defaultText?: string }[] = []
    if (!cursor.eat('{')) return members
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.eat(',')) continue
      const token = cursor.peek()!
      const traits = readTraits(cursor, this.source)
      if (!cursor.isIdent() || !cursor.is(':', 1)) {
        if (!cursor.is('}')) cursor.next()
        continue
      }
      const name = cursor.next().value
      cursor.next()
      let target = cursor.next().value
      while (cursor.is('#') || cursor.is('.')) {
        cursor.next()
        target = cursor.next().value
      }
      let defaultText: string | undefined
      if (cursor.eat('=')) {
        const start = cursor.index
        if (cursor.is('[') || cursor.is('{')) cursor.skipGroup()
        else cursor.next()
        defaultText = cursor.textBetween(this.source, start, cursor.index)
      }
      members.push({ name, target, traits, token, ...(defaultText !== undefined ? { defaultText } : {}) })
    }
    cursor.eat('}')
    return members
  }

  private structure(name: string, description: string | undefined) {
    const fields: RawField[] = this.members().map(({ name: memberName, target, traits, token, defaultText }) => {
      const field: RawField = { name: memberName, type: { name: target, args: [] } }
      // Members are optional unless @required (or given a default)
      const required = traits.some((trait) => trait.name === 'required')
      const defaultTrait = traits.find((trait) => trait.name === 'default')
      const defaultValue = defaultText ?? defaultTrait?.args
      if (defaultValue !== undefined) {
        const literal = parseLiteral(defaultValue)
        if (literal !== undefined) field.defaultValue = literal
      }
      if (!required && defaultValue === undefined) field.optional = true
      const jsonName = traits.find((trait) => trait.name === 'jsonName')
      const wire = jsonName ? annotationArg(jsonName, null) : undefined
      if (wire) field.serializedName = wire
      const doc = documentation(traits, token)
      if (doc) field.description = doc
      if (traits.length > 0) field.annotations = traits
      return field
    })
    this.declarations.models.push({
      name,
      kind: 'object',
      fields,
      construction: 'named',
      ...(this.namespace ? { namespace: this.namespace } : {}),
      ...(description ? { description } : {}),
    })
  }

  /** `list LineList { member: Line }` and `map Scores { key: String value: Integer }` are aliases. */
  private collection(keyword: string, name: string) {
    const members = this.members()
    const target = (member: string) => ({ name: members.find((item) => item.name === member)?.target ?? 'Document', args: [] })
    if (keyword === 'list' || keyword === 'set') this.declarations.aliases!.set(name, { name: '[]', args: [target('member')] })
    else if (keyword === 'map') this.declarations.aliases!.set(name, { name: '{}', args: [target('key'), target('value')] })
    // A union holds one of several shapes: a value of unknown shape for mapping
    else this.declarations.aliases!.set(name, { name: 'Document', args: [] })
  }

  private enumShape(name: string, description: string | undefined) {
    const { cursor } = this
    const enumDef: RawEnum = { name, values: [], ...(description ? { description } : {}) }
    if (!cursor.eat('{')) return
    while (!cursor.done && !cursor.is('}')) {
      readTraits(cursor, this.source)
      if (!cursor.isIdent()) {
        if (!cursor.is('}')) cursor.next()
        continue
      }
      const value: RawEnum['values'][number] = { name: cursor.next().value }
      if (cursor.eat('=')) {
        const token = cursor.next()
        if (token.kind === 'string') value.value = token.value
        else if (token.kind === 'number') value.value = Number(token.value)
      }
      enumDef.values.push(value)
      cursor.eat(',')
    }
    cursor.eat('}')
    this.declarations.enums.push(enumDef)
  }
}

export const smithyParser: InputParser = {
  id: 'smithy',
  kind: 'schema',
  label: 'Smithy',
  extensions: ['.smithy'],
  editorLanguage: 'kotlin',
  detect(text) {
    if (/^\s*\$version\s*:\s*"[12]/m.test(text)) return 0.99
    return /^\s*structure\s+\w+\s*\{/m.test(text) && /^\s*namespace\s+[\w.]+/m.test(text) ? 0.95 : 0
  },
  parse(text) {
    if (text.trim() === '') return failure('empty')
    let tokens: Token[]
    try {
      // `$version` and `metadata` lines start with `$`: read as punctuation, then skipped
      tokens = tokenize(text, C_LIKE)
    } catch (error) {
      if (error instanceof LexError) return failure(error.code, positionAt(text, error.index))
      throw error
    }
    const reader = new Reader(text, tokens)
    reader.run()
    if (reader.declarations.models.length === 0) return failure('noModels')
    const { schema, warnings } = buildSchema(reader.declarations, SMITHY_TYPES, 'smithy', 'smithy')
    return { ok: true, schema, warnings }
  },
}
