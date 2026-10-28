import { primitive, type Annotation } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { annotationArg, applyAnnotations, readAtAnnotation } from './annotations.ts'
import { Cursor, LexError, tokenize, type LexerConfig, type Token } from './lexer.ts'
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
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  nestedComments: true,
  strings: [
    { open: '"""', close: '"""', escapes: true, multiline: true },
    { open: "'''", close: "'''", escapes: true, multiline: true },
    { open: '"', close: '"', escapes: true, multiline: false },
    { open: "'", close: "'", escapes: true, multiline: false },
  ],
  stringPrefixes: /^r/,
  identifierChars: '$',
}

const SYNTAX: TypeSyntax = { generics: '<>', nullableSuffix: true }

export const DART_TYPES: TypeTable = {
  primitives: {
    String: primitive('string'),
    int: primitive('integer', 64),
    BigInt: primitive('integer'),
    double: primitive('float', 64),
    num: primitive('float'),
    Decimal: primitive('decimal'),
    bool: primitive('boolean'),
    DateTime: primitive('datetime'),
    Duration: primitive('duration'),
    Uint8List: primitive('binary'),
    dynamic: primitive('any'),
    Object: primitive('any'),
  },
  lists: ['List', 'Set', 'Iterable', 'BuiltList', 'BuiltSet'],
  maps: ['Map', 'BuiltMap'],
  optionals: [],
}

const MODIFIERS = new Set(['abstract', 'sealed', 'base', 'final', 'interface', 'mixin', 'external', 'late', 'covariant'])

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
    let annotations: Annotation[] = []
    // Documentation written above the annotations belongs to the declaration
    let annotationsDoc: string | undefined
    while (!cursor.done) {
      if (cursor.is('@')) {
        if (annotations.length === 0) annotationsDoc = cursor.peek()?.doc
        const annotation = readAtAnnotation(cursor, this.source)
        if (annotation) annotations.push(annotation)
        else cursor.next()
        continue
      }
      if (['import', 'export', 'part', 'library'].includes(cursor.value()) && cursor.peek()?.lineStart) {
        cursor.skipUntil([';'])
        cursor.eat(';')
        annotations = []
        continue
      }
      if (cursor.is('typedef') && cursor.isIdent(1) && cursor.is('=', 2)) {
        cursor.next()
        const name = cursor.next().value
        cursor.next()
        const type = readType(cursor, SYNTAX)
        if (type) this.declarations.aliases!.set(name, type)
        continue
      }
      const doc = cursor.peek()?.doc ?? (annotations.length > 0 ? annotationsDoc : undefined)
      const start = cursor.index
      while (MODIFIERS.has(cursor.value()) && (cursor.isIdent(1) || cursor.is('class', 1))) cursor.next()
      if (cursor.is('class') && cursor.isIdent(1)) {
        cursor.next()
        this.classDeclaration(annotations, doc)
        annotations = []
        continue
      }
      if (cursor.is('enum') && cursor.isIdent(1)) {
        cursor.next()
        this.enumDeclaration(doc)
        annotations = []
        continue
      }
      if (cursor.index === start) {
        if (cursor.is('{') || cursor.is('(')) cursor.skipGroup()
        else cursor.next()
      }
      annotations = []
    }
  }

  private classDeclaration(annotations: Annotation[], doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const generics: string[] = []
    if (cursor.is('<')) {
      cursor.next()
      while (!cursor.done && !cursor.is('>')) {
        if (cursor.isIdent() && (cursor.tokens[cursor.index - 1].value === '<' || cursor.tokens[cursor.index - 1].value === ','))
          generics.push(cursor.value())
        cursor.next()
      }
      cursor.eat('>')
    }
    const model: RawModel = { name, kind: 'class', fields: [], generics, construction: 'named' }
    if (doc) model.description = doc
    if (annotations.length > 0) model.annotations = annotations
    const names = new Set(annotations.map((item) => item.name))
    if (names.has('freezed') || names.has('Freezed')) model.framework = 'freezed'
    else if (names.has('JsonSerializable')) model.framework = 'json_serializable'
    model.extends = []
    while (!cursor.done && !cursor.is('{')) {
      if (cursor.eat('extends')) {
        const parent = readType(cursor, SYNTAX)
        if (parent) model.extends.push(parent.name)
      } else cursor.next()
    }
    this.declarations.models.push(model)
    this.body(model)
  }

  private body(model: RawModel) {
    const { cursor } = this
    if (!cursor.eat('{')) return
    const fields: RawField[] = []
    // Fields set by the constructor: `this.name` parameters, named (`{required this.id}`) or positional
    const constructorParams = new Map<string, { named: boolean; required: boolean; defaultValue?: string }>()
    let hasUnnamedConstructor = false
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.eat(';')) continue
      const doc = cursor.peek()?.doc
      const annotations: Annotation[] = []
      while (cursor.is('@')) {
        const annotation = readAtAnnotation(cursor, this.source)
        if (annotation) annotations.push(annotation)
        else cursor.next()
      }
      let isStatic = false
      let isConst = false
      let isFactory = false
      for (;;) {
        if (cursor.is('static')) isStatic = true
        else if (cursor.is('const')) isConst = true
        else if (cursor.is('factory')) isFactory = true
        else if (!['late', 'final', 'external', 'covariant', 'var'].includes(cursor.value())) break
        cursor.next()
      }
      // Constructors: Name(…), Name.named(…), const Name(…), factory Name(…) = _Name
      if (cursor.is(model.name) && (cursor.is('(', 1) || cursor.is('.', 1))) {
        cursor.next()
        const isNamedConstructor = cursor.eat('.')
        if (isNamedConstructor) cursor.next()
        const params = this.constructorParameters()
        if (!isNamedConstructor) {
          hasUnnamedConstructor = true
          for (const [name, info] of params.thisParams) constructorParams.set(name, info)
          // freezed: `const factory User({required String name}) = _User;` declares the fields
          if (isFactory && cursor.is('=')) fields.push(...params.typed)
          if (params.anyNamed) model.construction = 'named'
          else if (params.thisParams.size > 0 || params.typed.length > 0) model.construction = 'positional'
        }
        this.skipMember()
        continue
      }
      if (cursor.is('get') || cursor.is('set') || cursor.is('operator')) {
        this.skipMember()
        continue
      }
      const typeStart = cursor.index
      const type = readType(cursor, SYNTAX)
      const typeText = cursor.textBetween(this.source, typeStart, cursor.index)
      if (cursor.is('get') && cursor.isIdent(1)) {
        this.skipMember()
        continue
      }
      if (!type || !cursor.isIdent()) {
        // `final name = 'x';` without a type, or something else
        if (type && (cursor.is('=') || cursor.is(';')) && type.args.length === 0) {
          cursor.index = typeStart
          this.untypedField(fields, isStatic || isConst, doc)
          continue
        }
        this.skipMember()
        continue
      }
      const nameToken = cursor.next()
      if (cursor.is('(') || cursor.is('<')) {
        this.skipMember()
        continue
      }
      let initializer: string | undefined
      if (cursor.eat('=')) {
        const start = cursor.index
        cursor.skipUntil([';', ','])
        initializer = cursor.textBetween(this.source, start, cursor.index)
      }
      this.skipMember()
      if (isStatic || nameToken.value.startsWith('_')) continue
      const field: RawField = { name: nameToken.value, type, typeText }
      if (doc) field.description = doc
      if (initializer !== undefined) {
        const literal = parseLiteral(initializer)
        if (literal !== undefined) field.defaultValue = literal
      }
      if (applyAnnotations(field, this.jsonKey(annotations))) fields.push(field)
    }
    cursor.eat('}')
    for (const field of fields) {
      const param = constructorParams.get(field.name)
      if (param && param.named && !param.required) {
        field.optional = true
        if (param.defaultValue !== undefined) {
          const literal = parseLiteral(param.defaultValue)
          if (literal !== undefined) field.defaultValue = literal
        }
      }
    }
    if (!hasUnnamedConstructor) model.construction = 'named'
    model.fields = fields
  }

  /** `@JsonKey(name: 'x')`, also `includeFromJson: false` (not part of the data). */
  private jsonKey(annotations: Annotation[]): Annotation[] {
    return annotations.map((annotation) => {
      if (annotation.name !== 'JsonKey') return annotation
      if (annotationArg(annotation, 'ignore') === 'true' || annotationArg(annotation, 'includeFromJson') === 'false')
        return { ...annotation, name: 'JsonIgnore' }
      return annotation
    })
  }

  private untypedField(fields: RawField[], skip: boolean, doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    let initializer = ''
    if (cursor.eat('=')) {
      const start = cursor.index
      cursor.skipUntil([';'])
      initializer = cursor.textBetween(this.source, start, cursor.index)
    }
    cursor.eat(';')
    const literal = parseLiteral(initializer)
    if (skip || name.startsWith('_') || literal === undefined || literal === null) return
    const type: RawType = {
      name: typeof literal === 'string' ? 'String' : typeof literal === 'boolean' ? 'bool' : Number.isInteger(literal) ? 'int' : 'double',
      args: [],
    }
    const field: RawField = { name, type, defaultValue: literal }
    if (doc) field.description = doc
    fields.push(field)
  }

  private constructorParameters() {
    const { cursor } = this
    const thisParams = new Map<string, { named: boolean; required: boolean; defaultValue?: string }>()
    const typed: RawField[] = []
    let anyNamed = false
    if (!cursor.eat('(')) return { thisParams, typed, anyNamed }
    let named = false
    while (!cursor.done && !cursor.is(')')) {
      if (cursor.eat('{') || cursor.eat('[')) {
        named = cursor.tokens[cursor.index - 1].value === '{'
        if (named) anyNamed = true
        continue
      }
      if (cursor.eat('}') || cursor.eat(']') || cursor.eat(',')) continue
      const annotations: Annotation[] = []
      while (cursor.is('@')) {
        const annotation = readAtAnnotation(cursor, this.source)
        if (annotation) annotations.push(annotation)
        else cursor.next()
      }
      const required = cursor.eat('required')
      cursor.eat('final')
      if ((cursor.is('this') || cursor.is('super')) && cursor.is('.', 1)) {
        cursor.next()
        cursor.next()
        const name = cursor.next().value
        let defaultValue: string | undefined
        if (cursor.eat('=')) {
          const start = cursor.index
          cursor.skipUntil([',', '}', ']'])
          defaultValue = cursor.textBetween(this.source, start, cursor.index)
        }
        thisParams.set(name, { named, required: required || !named, ...(defaultValue !== undefined ? { defaultValue } : {}) })
        continue
      }
      const typeStart = cursor.index
      const type = readType(cursor, SYNTAX)
      const typeText = cursor.textBetween(this.source, typeStart, cursor.index)
      if (type && cursor.isIdent()) {
        const field: RawField = { name: cursor.next().value, type, typeText }
        const defaultAnnotation = annotations.find((item) => item.name === 'Default')
        if (defaultAnnotation?.args) {
          const literal = parseLiteral(defaultAnnotation.args)
          if (literal !== undefined) field.defaultValue = literal
          field.optional = true
        } else if (named && !required) field.optional = true
        if (applyAnnotations(field, this.jsonKey(annotations.filter((item) => item.name !== 'Default')))) typed.push(field)
      }
      cursor.skipUntil([',', '}', ']'])
    }
    cursor.eat(')')
    return { thisParams, typed, anyNamed }
  }

  /** Skips the rest of a member: an initializer list, a body or `;`. */
  private skipMember() {
    const { cursor } = this
    while (!cursor.done && !cursor.is(';') && !cursor.is('}')) {
      if (cursor.is('(') || cursor.is('[')) {
        cursor.skipGroup()
        continue
      }
      if (cursor.is('{')) {
        cursor.skipGroup()
        return
      }
      if (cursor.is('=>')) {
        cursor.skipUntil([';'])
        break
      }
      cursor.next()
    }
    cursor.eat(';')
  }

  private enumDeclaration(doc: string | undefined) {
    const { cursor } = this
    const name = cursor.next().value
    const enumDef: RawEnum = { name, values: [] }
    if (doc) enumDef.description = doc
    while (!cursor.done && !cursor.is('{')) cursor.next()
    if (!cursor.eat('{')) return
    while (!cursor.done && !cursor.is('}') && !cursor.is(';')) {
      let wire: string | undefined
      while (cursor.is('@')) {
        const annotation = readAtAnnotation(cursor, this.source)
        if (annotation?.name === 'JsonValue') wire = annotationArg(annotation, null) ?? annotation.args
      }
      if (!cursor.isIdent()) {
        cursor.next()
        continue
      }
      const value: RawEnum['values'][number] = { name: cursor.next().value }
      if (cursor.is('(')) {
        const first = cursor.peek(1)
        if (first?.kind === 'string') value.value = first.value
        else if (first?.kind === 'number') value.value = Number(first.value)
        cursor.skipGroup()
      }
      if (wire !== undefined) value.value = /^\d+$/.test(wire) ? Number(wire) : wire
      enumDef.values.push(value)
      cursor.eat(',')
    }
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

export const dartParser: InputParser = {
  id: 'dart',
  kind: 'code',
  label: 'Dart',
  extensions: ['.dart'],
  editorLanguage: 'dart',
  detect(text) {
    if (/^import\s+['"]package:/m.test(text) || /@(freezed|JsonSerializable)\b/.test(text)) return 0.95
    if (/\bfinal\s+[\w<>?, ]+\s+\w+\s*;/.test(text) && /\bclass\s+\w+/.test(text) && /\b(required\s+)?this\.\w+/.test(text)) return 0.9
    if (/\bclass\s+\w+/.test(text) && /\bfinal\s+(String|int|double|bool|DateTime|List<)/.test(text)) return 0.75
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
    const { schema, warnings } = buildSchema(reader.declarations, DART_TYPES, 'dart', 'dart')
    return { ok: true, schema, warnings }
  },
}
