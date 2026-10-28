import { toPascalCase, uniqueName } from '../../model/naming.ts'
import { primitive, type Annotation } from '../../model/schema.ts'
import { failure, positionAt, type InputParser, type ParseOutcome } from '../types.ts'
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
import { ZodReader } from './zod.ts'

const LEXER: LexerConfig = {
  ...C_LIKE,
  strings: [{ open: '`', close: '`', escapes: true, multiline: true }, ...C_LIKE.strings],
  identifierChars: '$',
}

export const TYPESCRIPT_TYPES: TypeTable = {
  primitives: {
    string: primitive('string'),
    String: primitive('string'),
    number: primitive('float'),
    Number: primitive('float'),
    // Zod's `.int()`: TypeScript has no integer type of its own
    integer: primitive('integer'),
    bigint: primitive('integer', 64),
    boolean: primitive('boolean'),
    Boolean: primitive('boolean'),
    Date: primitive('datetime'),
    any: primitive('any'),
    unknown: primitive('any'),
    object: primitive('any'),
    Object: primitive('any'),
    Buffer: primitive('binary'),
    Uint8Array: primitive('binary'),
    ArrayBuffer: primitive('binary'),
    Blob: primitive('binary'),
  },
  lists: ['Array', 'ReadonlyArray', 'Set', 'ReadonlySet'],
  maps: ['Record', 'Map', 'ReadonlyMap'],
  optionals: [],
  transparent: ['Readonly', 'Partial', 'Required', 'NonNullable', 'Promise'],
  nullNames: ['null', 'undefined', 'void'],
}

const MEMBER_MODIFIERS = new Set(['readonly', 'public', 'private', 'protected', 'declare', 'abstract', 'override', 'accessor', 'static'])
const PARAMETER_PROPERTY = new Set(['public', 'private', 'protected', 'readonly'])

function isLiteralName(name: string): boolean {
  return name.startsWith('"') || /^-?\d/.test(name)
}

function literalValue(name: string): string | number {
  return name.startsWith('"') ? (JSON.parse(name) as string) : Number(name)
}

/** Shared by TypeScript and JavaScript: JavaScript has no type annotations, so its fields get their
 * types from JSDoc or from their initial value. */
class Reader {
  readonly cursor: Cursor
  readonly source: string
  readonly javascript: boolean
  readonly declarations: RawDeclarations = { models: [], enums: [], aliases: new Map(), warnings: [] }
  readonly usedNames = new Set<string>()
  /** Models created for inline object types, merged into their alias when it is an intersection */
  private readonly inlineModels = new Set<string>()
  /** Name for the next inline object type (`address: { city: string }` → `UserAddress`) */
  private inlineHint = 'Inline'
  readonly syntax: TypeSyntax

  constructor(source: string, tokens: Token[], javascript: boolean) {
    this.source = source
    this.cursor = new Cursor(tokens)
    this.javascript = javascript
    this.syntax = {
      generics: '<>',
      arraySuffix: true,
      unions: true,
      intersections: true,
      nullablePrefix: javascript,
      custom: (cursor) => (cursor.is('{') ? this.inlineObject() : null),
    }
  }

  private reserve(name: string): string {
    this.usedNames.add(name)
    return name
  }

  run() {
    const { cursor } = this
    // Declared names first, so inline models never take a name used later in the file
    for (let index = 0; index < cursor.tokens.length - 1; index++) {
      const token = cursor.tokens[index]
      if (['interface', 'class', 'enum', 'type'].includes(token.value) && cursor.tokens[index + 1].kind === 'ident') {
        this.usedNames.add(cursor.tokens[index + 1].value)
      }
    }
    let decorators: Annotation[] = []
    while (!cursor.done) {
      if (cursor.is('@')) {
        const first = cursor.peek()!
        const decorator = readAtAnnotation(cursor, this.source)
        if (decorator) decorators.push(decorator)
        else cursor.next()
        this.passDoc(first)
        continue
      }
      if (['export', 'declare', 'default', 'abstract'].includes(cursor.value()) && cursor.peek()?.kind === 'ident') {
        this.passDoc(cursor.next())
        continue
      }
      if (cursor.is('interface') && cursor.isIdent(1) && !this.javascript) this.interfaceDeclaration()
      else if (cursor.is('type') && cursor.isIdent(1) && (cursor.is('=', 2) || cursor.is('<', 2)) && !this.javascript) this.typeAlias()
      else if (cursor.is('class') && cursor.isIdent(1)) this.classDeclaration(decorators)
      else if ((cursor.is('enum') && cursor.isIdent(1)) || (cursor.is('const') && cursor.is('enum', 1))) this.enumDeclaration()
      else if ((cursor.is('namespace') || cursor.is('module')) && cursor.isIdent(1)) {
        // Declarations inside a namespace are read like top-level ones
        cursor.next()
        while (!cursor.done && !cursor.is('{')) cursor.next()
        cursor.next()
      } else if (cursor.is('(') || cursor.is('[') || cursor.is('{')) cursor.skipGroup()
      else cursor.next()
      if (!cursor.is('@')) decorators = []
    }
    if (this.javascript) this.typedefs()
  }

  /** The documentation written before `export` or a decorator belongs to the declaration that follows. */
  private passDoc(from: Token) {
    const next = this.cursor.peek()
    if (next && from.doc !== undefined && next.doc === undefined) {
      this.cursor.tokens[this.cursor.index] = { ...next, doc: from.doc, docRaw: from.docRaw }
    }
  }

  private typeParameters(): string[] {
    const { cursor } = this
    if (!cursor.is('<')) return []
    const names: string[] = []
    let depth = 0
    do {
      const token = cursor.next()
      if (token.value === '<') depth++
      else if (token.value === '>') depth--
      else if (
        depth === 1 &&
        token.kind === 'ident' &&
        (cursor.tokens[cursor.index - 2]?.value === '<' || cursor.tokens[cursor.index - 2]?.value === ',')
      ) {
        names.push(token.value)
      }
    } while (!cursor.done && depth > 0)
    return names
  }

  private heritage(): string[] {
    const { cursor } = this
    const parents: string[] = []
    while (!cursor.done && !cursor.is('{')) {
      if (cursor.eat('extends')) {
        do {
          const type = readType(cursor, { generics: '<>' })
          if (type) parents.push(type.name)
        } while (cursor.eat(','))
      } else if (cursor.is('implements')) {
        // Implemented interfaces declare no data of their own
        cursor.next()
        do readType(cursor, { generics: '<>' })
        while (cursor.eat(','))
      } else cursor.next()
    }
    return parents
  }

  private interfaceDeclaration() {
    const { cursor } = this
    const doc = cursor.peek()?.doc
    cursor.next()
    const name = this.reserve(cursor.next().value)
    const model: RawModel = { name, kind: 'interface', fields: [], generics: this.typeParameters(), extends: this.heritage() }
    if (doc) model.description = doc
    this.declarations.models.push(model)
    model.fields = this.members(name)
  }

  private typeAlias() {
    const { cursor } = this
    const doc = cursor.peek()?.doc
    cursor.next()
    const name = this.reserve(cursor.next().value)
    const generics = this.typeParameters()
    cursor.eat('=')
    if (cursor.is('{')) {
      const model: RawModel = { name, kind: 'type', fields: [], generics }
      if (doc) model.description = doc
      this.declarations.models.push(model)
      model.fields = this.members(name)
      return
    }
    this.inlineHint = name
    const type = readType(cursor, this.syntax)
    if (!type) return
    const options = type.name === '|' ? type.args : [type]
    const literals = options.filter((option) => isLiteralName(option.name))
    if (
      literals.length > 0 &&
      literals.length === options.filter((option) => option.name !== 'null' && option.name !== 'undefined').length
    ) {
      const enumDef: RawEnum = { name, kind: 'literals', values: literals.map((option) => ({ name: String(literalValue(option.name)) })) }
      if (doc) enumDef.description = doc
      this.declarations.enums.push(enumDef)
      return
    }
    if (type.name === '&') {
      // `type Admin = User & { role: string }`: the inline parts become fields of Admin itself
      const model: RawModel = { name, kind: 'type', fields: [], generics, extends: [] }
      for (const part of type.args) {
        const inline = this.declarations.models.find((item) => item.name === part.name && this.inlineModels.has(item.name))
        if (inline) {
          model.fields.push(...inline.fields)
          this.declarations.models.splice(this.declarations.models.indexOf(inline), 1)
        } else model.extends!.push(part.name)
      }
      this.declarations.models.push(model)
      return
    }
    this.declarations.aliases!.set(name, type)
  }

  private inlineObject(): RawType {
    const name = uniqueName(toPascalCase(this.inlineHint) || 'Inline', this.usedNames)
    const model: RawModel = { name, kind: 'type', fields: [] }
    this.inlineModels.add(name)
    this.declarations.models.push(model)
    model.fields = this.members(name)
    return { name, args: [] }
  }

  /** Members between braces: properties of an interface, type literal or class. */
  private members(owner: string, isClass = false): RawField[] {
    const { cursor } = this
    const fields: RawField[] = []
    if (!cursor.eat('{')) return fields
    let decorators: Annotation[] = []
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.eat(';') || cursor.eat(',')) continue
      if (cursor.is('@')) {
        const decorator = readAtAnnotation(cursor, this.source)
        if (decorator) decorators.push(decorator)
        else cursor.next()
        continue
      }
      const doc = cursor.peek()?.doc
      const docRaw = cursor.peek()?.docRaw
      let isStatic = false
      while (
        MEMBER_MODIFIERS.has(cursor.value()) &&
        (cursor.isIdent(1) || cursor.peek(1)?.kind === 'string' || cursor.is('[', 1) || cursor.is('#', 1))
      ) {
        if (cursor.next().value === 'static') isStatic = true
      }
      if (cursor.is('[') || cursor.is('(') || cursor.is('<')) {
        // Index or call signatures: `[key: string]: T`, `(x: number): string`
        cursor.skipUntil([';', ','])
        decorators = []
        continue
      }
      if ((cursor.is('get') || cursor.is('set')) && (cursor.isIdent(1) || cursor.peek(1)?.kind === 'string') && cursor.is('(', 2)) {
        this.skipMethod()
        decorators = []
        continue
      }
      if (isClass && cursor.is('constructor') && cursor.is('(', 1)) {
        cursor.next()
        fields.push(...this.constructorProperties(docRaw))
        decorators = []
        continue
      }
      const privateName = cursor.eat('#')
      const nameToken = cursor.peek()
      if (!nameToken || (nameToken.kind !== 'ident' && nameToken.kind !== 'string' && nameToken.kind !== 'number')) {
        cursor.next()
        continue
      }
      cursor.next()
      if (cursor.is('(') || (cursor.is('<') && !this.javascript)) {
        cursor.index--
        this.skipMethod()
        decorators = []
        continue
      }
      // `name?: T` is read as `?:` by the lexer; `name!: T` is a definite assignment
      const optional = this.optionalMarker()
      if (!optional) cursor.eat('!')
      let type: RawType | null = null
      let typeStart = -1
      if (cursor.eat(':')) {
        this.inlineHint = `${owner}${toPascalCase(nameToken.value)}`
        typeStart = cursor.index
        type = readType(cursor, this.syntax)
      }
      const typeEnd = cursor.index
      let initializer: string | undefined
      if (cursor.eat('=')) initializer = this.readInitializer()
      if (isStatic || privateName) {
        decorators = []
        continue
      }
      if (!type && initializer !== undefined) type = typeOfInitializer(initializer)
      if (this.javascript && docRaw) type = jsDocType(docRaw, /@type\s*\{/) ?? type
      const field: RawField = { name: nameToken.value, type: this.literalUnionToEnum(type, owner, nameToken.value), optional }
      if (typeStart >= 0 && typeEnd > typeStart) field.typeText = cursor.textBetween(this.source, typeStart, typeEnd)
      if (doc) field.description = doc
      if (initializer !== undefined) {
        const literal = parseLiteral(initializer)
        if (literal !== undefined) field.defaultValue = literal
      }
      if (applyAnnotations(field, decorators)) fields.push(field)
      decorators = []
    }
    cursor.eat('}')
    return fields
  }

  /** `status: 'active' | 'blocked'` creates an enum, so mapping its values can be checked. */
  private literalUnionToEnum(type: RawType | null, owner: string, fieldName: string): RawType | null {
    if (!type || type.name !== '|') return type
    const literals = type.args.filter((option) => isLiteralName(option.name))
    const others = type.args.filter((option) => !isLiteralName(option.name))
    if (literals.length < 2 || others.some((option) => option.name !== 'null' && option.name !== 'undefined')) return type
    const name = uniqueName(toPascalCase(fieldName) || `${owner}Value`, this.usedNames)
    this.declarations.enums.push({
      name,
      kind: 'literals',
      values: literals.map((option) => ({ name: String(literalValue(option.name)) })),
    })
    const enumType: RawType = { name, args: [] }
    return others.length > 0 ? { name: '|', args: [enumType, ...others] } : enumType
  }

  /** `?` after a name, also when the lexer read it together with the colon (`?:`), which is left as `:`. */
  private optionalMarker(): boolean {
    const { cursor } = this
    if (cursor.is('?:')) {
      cursor.tokens[cursor.index] = { ...cursor.tokens[cursor.index], value: ':' }
      return true
    }
    return cursor.eat('?')
  }

  private readInitializer(): string {
    const { cursor } = this
    const start = cursor.index
    let depth = 0
    while (!cursor.done) {
      const token = cursor.peek()!
      if (cursor.index > start && depth === 0 && (token.lineStart || cursor.is(';') || cursor.is(',') || cursor.is('}'))) break
      if (token.kind === 'punct' && ['(', '[', '{'].includes(token.value)) depth++
      if (token.kind === 'punct' && [')', ']', '}'].includes(token.value)) depth--
      cursor.next()
    }
    return cursor.textBetween(this.source, start, cursor.index)
  }

  private skipMethod() {
    const { cursor } = this
    while (!cursor.done && !cursor.is('(')) cursor.next()
    cursor.skipGroup()
    if (cursor.eat(':')) readType(cursor, this.syntax)
    if (cursor.is('{')) cursor.skipGroup()
  }

  /** `constructor(public id: number, private readonly name?: string)` declares properties (TypeScript);
   * in JavaScript, `this.x = …` assignments in the body do. */
  private constructorProperties(docRaw: string | undefined): RawField[] {
    const { cursor } = this
    const fields: RawField[] = []
    const paramTypes = new Map<string, RawType | null>()
    cursor.next()
    while (!cursor.done && !cursor.is(')')) {
      const decorators: Annotation[] = []
      while (cursor.is('@')) {
        const decorator = readAtAnnotation(cursor, this.source)
        if (decorator) decorators.push(decorator)
        else break
      }
      let property = false
      while (PARAMETER_PROPERTY.has(cursor.value()) && cursor.isIdent(1)) {
        cursor.next()
        property = true
      }
      if (!cursor.isIdent()) {
        cursor.skipUntil([','])
        cursor.eat(',')
        continue
      }
      const name = cursor.next().value
      const optional = this.optionalMarker()
      let type: RawType | null = null
      if (cursor.eat(':')) {
        this.inlineHint = name
        type = readType(cursor, this.syntax)
      }
      let defaultValue: string | undefined
      if (cursor.eat('=')) {
        const start = cursor.index
        cursor.skipUntil([','])
        defaultValue = cursor.textBetween(this.source, start, cursor.index)
      }
      if (!type && defaultValue !== undefined) type = typeOfInitializer(defaultValue)
      paramTypes.set(name, type ?? (docRaw ? jsDocParam(docRaw, name) : null))
      if (property) {
        const field: RawField = { name, type, optional: optional || defaultValue !== undefined }
        if (defaultValue !== undefined) {
          const literal = parseLiteral(defaultValue)
          if (literal !== undefined) field.defaultValue = literal
        }
        if (applyAnnotations(field, decorators)) fields.push(field)
      }
      cursor.eat(',')
    }
    cursor.eat(')')
    if (!cursor.is('{')) return fields
    // this.name = name; in the body
    const bodyStart = cursor.index
    cursor.skipGroup()
    const bodyEnd = cursor.index
    for (let index = bodyStart; index < bodyEnd - 3; index++) {
      const tokens = cursor.tokens
      if (
        tokens[index].value === 'this' &&
        tokens[index + 1].value === '.' &&
        tokens[index + 2].kind === 'ident' &&
        tokens[index + 3].value === '='
      ) {
        const name = tokens[index + 2].value
        if (fields.some((field) => field.name === name)) continue
        const valueToken = tokens[index + 4]
        let type: RawType | null = null
        if (valueToken?.kind === 'ident' && paramTypes.has(valueToken.value)) type = paramTypes.get(valueToken.value) ?? null
        else if (valueToken) {
          let end = index + 4
          while (end < bodyEnd && tokens[end].line === valueToken.line && tokens[end].value !== ';') end++
          type = typeOfInitializer(cursor.textBetween(this.source, index + 4, end))
        }
        fields.push({ name, type })
      }
    }
    return fields
  }

  private classDeclaration(decorators: Annotation[]) {
    const { cursor } = this
    const doc = cursor.peek()?.doc
    cursor.next()
    const name = this.reserve(cursor.next().value)
    const model: RawModel = { name, kind: 'class', fields: [], generics: this.typeParameters(), extends: this.heritage() }
    if (doc) model.description = doc
    if (decorators.length > 0) model.annotations = decorators
    if (decorators.some((item) => item.name === 'Entity' || item.name === 'ViewEntity')) {
      model.kind = 'entity'
      model.framework = 'typeorm'
    }
    model.construction = 'properties'
    this.declarations.models.push(model)
    // Class fields declared after the constructor still win over the constructor's assignments
    const fields = this.members(name, true)
    const seen = new Set<string>()
    model.fields = fields.filter((field) => (seen.has(field.name) ? false : (seen.add(field.name), true)))
  }

  private enumDeclaration() {
    const { cursor } = this
    const doc = cursor.peek()?.doc
    cursor.eat('const')
    cursor.next()
    const name = this.reserve(cursor.next().value)
    const enumDef: RawEnum = { name, values: [] }
    if (doc) enumDef.description = doc
    if (!cursor.eat('{')) return
    let next = 0
    while (!cursor.done && !cursor.is('}')) {
      const token = cursor.next()
      if (token.kind !== 'ident' && token.kind !== 'string') continue
      const value: RawEnum['values'][number] = { name: token.value }
      if (cursor.eat('=')) {
        const valueToken = cursor.next()
        if (valueToken.kind === 'string') value.value = valueToken.value
        else if (valueToken.kind === 'number') {
          value.value = Number(valueToken.value)
          next = Number(valueToken.value) + 1
        } else if (valueToken.value === '-' && cursor.peek()?.kind === 'number') {
          value.value = -Number(cursor.next().value)
          next = (value.value as number) + 1
        }
        cursor.skipUntil([','])
      } else value.value = next++
      enumDef.values.push(value)
      cursor.eat(',')
    }
    cursor.eat('}')
    this.declarations.enums.push(enumDef)
  }

  /** JSDoc `@typedef {Object} User` blocks with `@property {string} [nickname]` lines. */
  private typedefs() {
    const blocks = new Set(
      this.cursor.tokens.map((token) => token.docRaw).filter((raw): raw is string => raw !== undefined && raw.includes('@typedef')),
    )
    // Comments at the end of the file belong to no token
    for (const match of this.source.matchAll(/\/\*\*[\s\S]*?\*\//g)) if (match[0].includes('@typedef')) blocks.add(match[0])
    for (const block of blocks) {
      const header = /@typedef\s*(?:\{([^}]*)\})?\s*([\w$]+)/.exec(block)
      if (!header || this.declarations.models.some((model) => model.name === header[2])) continue
      const fields: RawField[] = []
      for (const property of block.matchAll(/@prop(?:erty)?\s*\{([^}]*)\}\s*(\[?)([\w$.]+)(?:=([^\]\s]*))?\]?[ \t]*(?:-[ \t]*)?(.*)/g)) {
        if (property[3].includes('.')) continue
        const field: RawField = { name: property[3], type: parseJsDocType(property[1]), optional: property[2] === '[' }
        if (property[4] !== undefined) {
          const literal = parseLiteral(property[4])
          if (literal !== undefined) field.defaultValue = literal
        }
        const description = property[5]?.replace(/\*\/\s*$/, '').trim()
        if (description) field.description = description
        fields.push(field)
      }
      this.declarations.models.push({ name: this.reserve(header[2]), kind: 'type', fields })
    }
  }
}

/** Type of an initial value: `''` is a string, `0` a number, `[]` an array, `new Date()` a date. */
function typeOfInitializer(text: string): RawType | null {
  const value = text.trim()
  if (/^["'`]/.test(value)) return { name: 'string', args: [] }
  if (/^-?\d/.test(value)) return { name: 'number', args: [] }
  if (/^(true|false)$/.test(value)) return { name: 'boolean', args: [] }
  if (/^new\s+Date\b/.test(value)) return { name: 'Date', args: [] }
  if (/^\[/.test(value)) return { name: '[]', args: [{ name: 'any', args: [] }] }
  if (/^new\s+(Map|Set)\b/.test(value)) return { name: /^new\s+Map/.test(value) ? 'Map' : 'Set', args: [] }
  if (value === 'null' || value === 'undefined') return { name: 'any', args: [], nullable: true }
  return null
}

const JSDOC_SYNTAX: TypeSyntax = { generics: '<>', arraySuffix: true, unions: true, nullablePrefix: true }

function parseJsDocType(text: string): RawType | null {
  try {
    const tokens = tokenize(
      text
        .replace(/^\(|\)$/g, '')
        .replace(/Object\.</g, 'Object<')
        .replace(/\*/g, 'any'),
      LEXER,
    )
    const type = readType(new Cursor(tokens), JSDOC_SYNTAX)
    if (type?.name === 'Object' && type.args.length === 2) return { name: 'Record', args: type.args }
    return type
  } catch {
    return null
  }
}

function jsDocType(docRaw: string, tag: RegExp): RawType | null {
  const match = new RegExp(`${tag.source}([^}]*)\\}`).exec(docRaw)
  return match ? parseJsDocType(match[1]) : null
}

function jsDocParam(docRaw: string, name: string): RawType | null {
  const match = new RegExp(`@param\\s*\\{([^}]*)\\}\\s*\\[?${name.replace(/\$/g, '\\$')}\\b`).exec(docRaw)
  return match ? parseJsDocType(match[1]) : null
}

function parseScript(text: string, javascript: boolean): ParseOutcome {
  if (text.trim() === '') return failure('empty')
  let tokens: Token[]
  try {
    tokens = tokenize(text, LEXER)
  } catch (error) {
    if (error instanceof LexError) return failure(error.code, positionAt(text, error.index))
    throw error
  }
  const reader = new Reader(text, tokens, javascript)
  reader.run()
  if (ZodReader.uses(tokens)) new ZodReader(new Cursor(tokens), text, reader.declarations, reader.usedNames).run()
  const declarations = reader.declarations
  if (declarations.models.length === 0) return failure('noModels')
  const language = javascript ? 'javascript' : 'typescript'
  const { schema, warnings } = buildSchema(declarations, TYPESCRIPT_TYPES, language, language)
  return { ok: true, schema, warnings }
}

export const typeScriptParser: InputParser = {
  id: 'typescript',
  kind: 'code',
  label: 'TypeScript',
  extensions: ['.ts', '.tsx', '.mts', '.cts'],
  editorLanguage: 'typescript',
  detect(text) {
    if (/^\s*(export\s+)?(declare\s+)?(interface|type)\s+\w+[\s<={]/m.test(text))
      return /:\s*(string|number|boolean)\b/.test(text) ? 0.95 : 0.9
    if (
      /^\s*(export\s+)?(abstract\s+)?class\s+\w+/m.test(text) &&
      /\w[?!]?\s*:\s*(string|number|boolean|Date|[A-Z]\w*)(\[\])?\s*[;=\n]/.test(text)
    )
      return 0.85
    if (/^\s*(export\s+)?(const\s+)?enum\s+\w+\s*\{/m.test(text)) return 0.6
    if (/\bz\.object\(/.test(text)) return 0.9
    return 0
  },
  parse: (text) => parseScript(text, false),
}

export const javaScriptParser: InputParser = {
  id: 'javascript',
  kind: 'code',
  label: 'JavaScript',
  extensions: ['.js', '.mjs', '.cjs', '.jsx'],
  editorLanguage: 'javascript',
  detect(text) {
    if (/@typedef\s*\{/.test(text)) return 0.8
    if (/^\s*(export\s+(default\s+)?)?class\s+\w+/m.test(text) && /this\.\w+\s*=/.test(text)) return 0.7
    if (
      /^\s*(export\s+(default\s+)?)?class\s+\w+/m.test(text) &&
      !/:\s*(string|number|boolean)\b/.test(text) &&
      /^\s+\w+\s*=\s*[^=]/m.test(text)
    )
      return 0.5
    return 0
  },
  parse: (text) => parseScript(text, true),
}
