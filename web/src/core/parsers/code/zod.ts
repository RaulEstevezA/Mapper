import { toPascalCase, uniqueName } from '../../model/naming.ts'
import type { Literal } from '../../model/schema.ts'
import type { Cursor, Token } from './lexer.ts'
import { parseLiteral, type RawDeclarations, type RawField, type RawModel, type RawType } from './raw.ts'

/** Zod schemas in TypeScript (`export const UserSchema = z.object({ … })`), as Api2Class writes them
 * with its Zod style. They are read as tokens, like every declaration: nothing is run. */

interface ZodValue {
  type: RawType | null
  nullable: boolean
  optional: boolean
  defaultValue?: Literal
  description?: string
}

const STRING_LIKE = new Set([
  'string',
  'email',
  'url',
  'uuid',
  'cuid',
  'cuid2',
  'ulid',
  'ipv4',
  'ipv6',
  'base64',
  'emoji',
  'nanoid',
  'jwt',
  'templateLiteral',
])

export class ZodReader {
  private readonly cursor: Cursor
  private readonly source: string
  private readonly declarations: RawDeclarations
  private readonly usedNames: Set<string>
  /** Schema constant → model name (`UserSchema` → `User`, from `type User = z.infer<typeof UserSchema>`) */
  private readonly names = new Map<string, string>()

  constructor(cursor: Cursor, source: string, declarations: RawDeclarations, usedNames: Set<string>) {
    this.cursor = cursor
    this.source = source
    this.declarations = declarations
    this.usedNames = usedNames
  }

  /** Whether the file uses Zod at all: `z.object(`, `z.enum(`… */
  static uses(tokens: Token[]): boolean {
    return tokens.some((token, index) => token.value === 'z' && tokens[index + 1]?.value === '.' && tokens[index + 2]?.kind === 'ident')
  }

  private modelName(constant: string): string {
    return this.names.get(constant) ?? (constant.replace(/Schema$/, '') || constant)
  }

  run() {
    const { tokens } = this.cursor
    // Names first: `type User = z.infer<typeof UserSchema>` (also z.output / z.input)
    for (let index = 0; index < tokens.length - 8; index++) {
      if (tokens[index].value !== 'type' || tokens[index + 2]?.value !== '=' || tokens[index + 3]?.value !== 'z') continue
      if (!['infer', 'output', 'input', 'TypeOf'].includes(tokens[index + 5]?.value) || tokens[index + 7]?.value !== 'typeof') continue
      this.names.set(tokens[index + 8].value, tokens[index + 1].value)
    }
    for (let index = 0; index < tokens.length - 3; index++) {
      const token = tokens[index]
      if (!['const', 'let', 'var'].includes(token.value) || tokens[index + 1]?.kind !== 'ident' || tokens[index + 2]?.value !== '=')
        continue
      if (tokens[index + 3]?.value !== 'z' && !this.names.has(tokens[index + 3]?.value) && !/Schema$/.test(tokens[index + 3]?.value ?? ''))
        continue
      const constant = tokens[index + 1].value
      this.cursor.index = index + 3
      const name = this.modelName(constant)
      const doc = token.doc ?? tokens[index - 1]?.doc
      this.declaration(name, constant, doc)
      index = Math.max(index, this.cursor.index - 1)
    }
  }

  private declaration(name: string, constant: string, doc: string | undefined) {
    const { cursor } = this
    // `z.object({ … })` (maybe extended) is a model; `z.enum([…])` an enum; anything else an alias
    if (cursor.is('z') && cursor.is('.', 1) && ['object', 'strictObject', 'looseObject'].includes(cursor.value(2))) {
      cursor.index += 3
      const model: RawModel = { name, kind: 'type', fields: this.objectFields(name), framework: 'zod' }
      if (doc) model.description = doc
      this.usedNames.add(name)
      this.declarations.models.push(model)
      this.chain({ type: { name, args: [] }, nullable: false, optional: false }, model)
      return
    }
    if (cursor.is('z') && cursor.is('.', 1) && cursor.is('enum', 2) && cursor.is('(', 3)) {
      cursor.index += 4
      const values = this.enumValues()
      this.usedNames.add(name)
      this.declarations.enums.push({ name, kind: 'literals', values: values.map((value) => ({ name: value })) })
      return
    }
    // An object built from another schema: `BaseSchema.extend({ … })`
    if (cursor.isIdent() && cursor.is('.', 1) && cursor.is('extend', 2)) {
      const parent = this.modelName(cursor.value())
      cursor.index += 3
      const model: RawModel = { name, kind: 'type', fields: [], extends: [parent], framework: 'zod' }
      if (cursor.eat('(')) {
        cursor.index--
        model.fields = this.objectFields(name, true)
      }
      this.usedNames.add(name)
      this.declarations.models.push(model)
      return
    }
    const value = this.value(name)
    if (value.type && constant !== name) this.declarations.aliases?.set(name, value.type)
  }

  /** Fields of `({ key: schema, … })`; the cursor is on `(`. */
  private objectFields(owner: string, alreadyOpen = false): RawField[] {
    const { cursor } = this
    const fields: RawField[] = []
    if (!alreadyOpen && !cursor.eat('(')) return fields
    if (alreadyOpen) cursor.eat('(')
    if (!cursor.eat('{')) {
      cursor.skipUntil([')'])
      cursor.eat(')')
      return fields
    }
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.eat(',')) continue
      if (cursor.is('...')) {
        // `...BaseSchema.shape`: the fields of another schema
        cursor.next()
        cursor.skipUntil([',', '}'])
        continue
      }
      const key = cursor.peek()
      if (!key || (key.kind !== 'ident' && key.kind !== 'string') || !cursor.is(':', 1)) {
        cursor.skipUntil([',', '}'])
        continue
      }
      cursor.index += 2
      const value = this.value(`${owner}${toPascalCase(key.value)}`)
      const field: RawField = { name: key.value, type: value.type, optional: value.optional, nullable: value.nullable }
      if (value.defaultValue !== undefined) field.defaultValue = value.defaultValue
      const description = value.description ?? key.doc
      if (description) field.description = description
      fields.push(field)
    }
    cursor.eat('}')
    cursor.skipUntil([')'])
    cursor.eat(')')
    return fields
  }

  private enumValues(): string[] {
    const { cursor } = this
    const values: string[] = []
    cursor.eat('[')
    while (!cursor.done && !cursor.is(']') && !cursor.is(')')) {
      const token = cursor.next()
      if (token.kind === 'string') values.push(token.value)
    }
    cursor.eat(']')
    cursor.skipUntil([')'])
    cursor.eat(')')
    return values
  }

  /** The arguments of a call as zod values (`z.union([a, b])`, `z.record(k, v)`). */
  private arguments(hint: string): ZodValue[] {
    const { cursor } = this
    const values: ZodValue[] = []
    if (!cursor.eat('(')) return values
    const list = cursor.eat('[')
    while (!cursor.done && !cursor.is(')') && !cursor.is(']')) {
      if (cursor.eat(',')) continue
      const start = cursor.index
      values.push(this.value(hint))
      if (cursor.index === start) cursor.next()
    }
    if (list) cursor.eat(']')
    cursor.skipUntil([')'])
    cursor.eat(')')
    return values
  }

  /** A zod expression: a base (`z.string()`, another schema) and its chained methods. */
  private value(hint: string): ZodValue {
    const { cursor } = this
    let value: ZodValue = { type: null, nullable: false, optional: false }
    if (cursor.is('z') && cursor.is('.', 1)) {
      cursor.index += 2
      // z.coerce.number(), z.iso.datetime(), z.string.email()…
      while (cursor.isIdent() && cursor.is('.', 1)) cursor.index += 2
      const method = cursor.next().value
      value = this.base(method, hint)
    } else if (cursor.isIdent()) {
      const name = cursor.next().value
      value = { type: { name: this.modelName(name), args: [] }, nullable: false, optional: false }
    } else if (cursor.peek()?.kind === 'string' || cursor.peek()?.kind === 'number') {
      const token = cursor.next()
      return { type: { name: token.kind === 'string' ? 'string' : 'number', args: [] }, nullable: false, optional: false }
    } else {
      cursor.skipUntil([',', '}', ')'])
      return value
    }
    return this.chain(value)
  }

  private base(method: string, hint: string): ZodValue {
    const plain = (name: string): ZodValue => {
      this.cursor.skipGroup()
      return { type: { name, args: [] }, nullable: false, optional: false }
    }
    switch (method) {
      case 'number':
      case 'float32':
      case 'float64':
        return plain('number')
      case 'int':
      case 'int32':
      case 'int64':
      case 'bigint':
        return plain('integer')
      case 'boolean':
        return plain('boolean')
      case 'date':
        return plain('Date')
      case 'null':
      case 'undefined':
      case 'void':
        return { ...plain('null'), nullable: true }
      case 'any':
      case 'unknown':
      case 'json':
        return plain('unknown')
      case 'array':
      case 'set': {
        const [items] = this.arguments(`${hint}Item`)
        return {
          type: { name: '[]', args: items?.type ? [{ ...items.type, nullable: items.nullable }] : [] },
          nullable: false,
          optional: false,
        }
      }
      case 'record':
      case 'map': {
        const args = this.arguments(`${hint}Value`)
        const valueType = args[args.length - 1]?.type ?? { name: 'unknown', args: [] }
        return { type: { name: '{}', args: [{ name: 'string', args: [] }, valueType] }, nullable: false, optional: false }
      }
      case 'object':
      case 'strictObject':
      case 'looseObject': {
        const name = uniqueName(toPascalCase(hint) || 'Inline', this.usedNames)
        this.declarations.models.push({ name, kind: 'type', fields: this.objectFields(name), framework: 'zod' })
        return { type: { name, args: [] }, nullable: false, optional: false }
      }
      case 'enum': {
        this.cursor.eat('(')
        const values = this.enumValues()
        const name = uniqueName(toPascalCase(hint) || 'Value', this.usedNames)
        this.declarations.enums.push({ name, kind: 'literals', values: values.map((item) => ({ name: item })) })
        return { type: { name, args: [] }, nullable: false, optional: false }
      }
      case 'nativeEnum': {
        const [inner] = this.arguments(hint)
        return inner ?? { type: null, nullable: false, optional: false }
      }
      case 'literal': {
        this.cursor.eat('(')
        const token = this.cursor.next()
        this.cursor.skipUntil([')'])
        this.cursor.eat(')')
        return {
          type: {
            name: token.kind === 'number' ? 'number' : token.value === 'true' || token.value === 'false' ? 'boolean' : 'string',
            args: [],
          },
          nullable: false,
          optional: false,
        }
      }
      case 'union':
      case 'discriminatedUnion': {
        const options = this.arguments(hint).filter((option) => option.type)
        const nullable = options.some((option) => option.type?.name === 'null')
        const rest = options.filter((option) => option.type?.name !== 'null')
        if (rest.length === 1) return { ...rest[0], nullable: rest[0].nullable || nullable }
        return { type: { name: 'unknown', args: [] }, nullable, optional: false }
      }
      case 'nullable':
      case 'optional':
      case 'nullish':
      case 'lazy': {
        // z.nullable(X), z.optional(X), z.lazy(() => X)
        this.cursor.eat('(')
        if (this.cursor.is('(')) this.cursor.skipGroup()
        this.cursor.eat('=>')
        const inner = this.value(hint)
        this.cursor.skipUntil([')'])
        this.cursor.eat(')')
        if (method === 'nullable') return { ...inner, nullable: true }
        if (method === 'optional') return { ...inner, optional: true }
        if (method === 'nullish') return { ...inner, nullable: true, optional: true }
        return inner
      }
      default:
        // Text with a format (z.email(), z.uuid(), z.iso.datetime()): at run time it is a string
        return plain(STRING_LIKE.has(method) || ['datetime', 'time', 'duration'].includes(method) ? 'string' : 'unknown')
    }
  }

  /** Chained methods: `.int()`, `.nullable()`, `.optional()`, `.default(v)`, `.array()`, `.describe(…)`. */
  private chain(value: ZodValue, model?: RawModel): ZodValue {
    const { cursor } = this
    let result = value
    while (cursor.is('.') && cursor.isIdent(1)) {
      cursor.next()
      const method = cursor.next().value
      const argsStart = cursor.index
      if (method === 'extend' && model) {
        model.fields.push(...this.objectFields(model.name))
        continue
      }
      if (cursor.is('(')) cursor.skipGroup()
      const args = cursor
        .textBetween(this.source, argsStart, cursor.index)
        .replace(/^\(|\)$/g, '')
        .trim()
      switch (method) {
        case 'int':
          if (result.type?.name === 'number') result = { ...result, type: { name: 'integer', args: [] } }
          break
        case 'nullable':
          result = { ...result, nullable: true }
          break
        case 'optional':
          result = { ...result, optional: true }
          break
        case 'nullish':
          result = { ...result, nullable: true, optional: true }
          break
        case 'array':
          result = { type: { name: '[]', args: result.type ? [result.type] : [] }, nullable: false, optional: false }
          break
        case 'default':
        case 'catch': {
          const literal = parseLiteral(args)
          result = { ...result, optional: true, ...(literal !== undefined ? { defaultValue: literal } : {}) }
          break
        }
        case 'describe': {
          const literal = parseLiteral(args)
          if (typeof literal === 'string') result = { ...result, description: literal }
          break
        }
        default:
          // Checks and refinements (min, max, email, regex, refine, transform…) do not change the shape
          break
      }
    }
    return result
  }
}
