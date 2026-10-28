import { toPascalCase } from '../../model/naming.ts'
import { primitive, type Annotation } from '../../model/schema.ts'
import { failure, positionAt, type InputParser } from '../types.ts'
import { annotationArg, readAtAnnotation } from './annotations.ts'
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
  lineComments: ['#'],
  blockComments: [],
  strings: [
    { open: '"""', close: '"""', escapes: true, multiline: true },
    { open: "'''", close: "'''", escapes: true, multiline: true },
    { open: '"', close: '"', escapes: true, multiline: false },
    { open: "'", close: "'", escapes: true, multiline: false },
  ],
  stringPrefixes: /^(rb|br|fr|rf|Rb|bR|[rbfuRBFU])/,
}

const SYNTAX: TypeSyntax = { generics: '[]', unions: true }

export const PYTHON_TYPES: TypeTable = {
  primitives: {
    str: primitive('string'),
    EmailStr: primitive('string'),
    HttpUrl: primitive('string'),
    AnyUrl: primitive('string'),
    SecretStr: primitive('string'),
    constr: primitive('string'),
    int: primitive('integer'),
    PositiveInt: primitive('integer'),
    NonNegativeInt: primitive('integer'),
    conint: primitive('integer'),
    float: primitive('float'),
    PositiveFloat: primitive('float'),
    confloat: primitive('float'),
    Decimal: primitive('decimal'),
    condecimal: primitive('decimal'),
    bool: primitive('boolean'),
    StrictBool: primitive('boolean'),
    bytes: primitive('binary'),
    bytearray: primitive('binary'),
    datetime: primitive('datetime'),
    AwareDatetime: primitive('datetime'),
    date: primitive('date'),
    time: primitive('time'),
    timedelta: primitive('duration'),
    UUID: primitive('uuid'),
    UUID4: primitive('uuid'),
    Any: primitive('any'),
    object: primitive('any'),
    Json: primitive('any'),
  },
  lists: [
    'list',
    'List',
    'Sequence',
    'MutableSequence',
    'set',
    'Set',
    'frozenset',
    'FrozenSet',
    'tuple',
    'Tuple',
    'Iterable',
    'Collection',
  ],
  maps: ['dict', 'Dict', 'Mapping', 'MutableMapping', 'DefaultDict', 'OrderedDict'],
  optionals: ['Optional'],
  transparent: ['Mapped', 'Annotated', 'Final', 'Required', 'ReadOnly', 'NotRequired'],
  nullNames: ['None', 'NoneType'],
}

const ENUM_BASES = new Set(['Enum', 'IntEnum', 'StrEnum', 'Flag', 'IntFlag', 'TextChoices', 'IntegerChoices', 'Choices'])

// Django field classes: type, and whether the database fills them in
const DJANGO_FIELDS: Record<string, string> = {
  CharField: 'str',
  TextField: 'str',
  SlugField: 'str',
  EmailField: 'str',
  URLField: 'str',
  GenericIPAddressField: 'str',
  FilePathField: 'str',
  FileField: 'str',
  ImageField: 'str',
  IntegerField: 'int',
  SmallIntegerField: 'int',
  BigIntegerField: 'int',
  PositiveIntegerField: 'int',
  PositiveSmallIntegerField: 'int',
  PositiveBigIntegerField: 'int',
  AutoField: 'int',
  BigAutoField: 'int',
  SmallAutoField: 'int',
  FloatField: 'float',
  DecimalField: 'Decimal',
  BooleanField: 'bool',
  NullBooleanField: 'bool',
  DateTimeField: 'datetime',
  DateField: 'date',
  TimeField: 'time',
  DurationField: 'timedelta',
  UUIDField: 'UUID',
  BinaryField: 'bytes',
  JSONField: 'Any',
}

// SQLAlchemy column types
const SQLALCHEMY_TYPES: Record<string, string> = {
  String: 'str',
  Text: 'str',
  Unicode: 'str',
  UnicodeText: 'str',
  VARCHAR: 'str',
  Integer: 'int',
  SmallInteger: 'int',
  BigInteger: 'int',
  Float: 'float',
  Numeric: 'Decimal',
  DECIMAL: 'Decimal',
  Boolean: 'bool',
  DateTime: 'datetime',
  Date: 'date',
  Time: 'time',
  Interval: 'timedelta',
  Uuid: 'UUID',
  UUID: 'UUID',
  LargeBinary: 'bytes',
  JSON: 'Any',
  Enum: 'str',
}

/** Python writes `Union[A, None]`, `Literal['a', 'b']` and forward references as strings (`"User"`);
 * they are turned into the common forms. */
function normalize(type: RawType | null): RawType | null {
  if (!type) return null
  const simple = type.name.split('.').pop()!
  if (simple === 'Literal')
    return { name: '|', args: type.args.map((arg) => ({ ...arg, name: arg.name.startsWith('"') ? arg.name : JSON.stringify(arg.name) })) }
  const args = type.args.map((arg) => normalize(arg)!).filter(Boolean)
  if (simple === 'Union') return { name: '|', args }
  if (type.name.startsWith('"')) {
    const inner = JSON.parse(type.name) as string
    if (/^[\w.]+$/.test(inner)) return { name: inner, args: [] }
  }
  return { ...type, name: type.name, args }
}

interface Statement {
  start: number
  end: number
}

class Reader {
  readonly cursor: Cursor
  readonly source: string
  readonly declarations: RawDeclarations = { models: [], enums: [], aliases: new Map(), warnings: [] }

  constructor(source: string, tokens: Token[]) {
    this.source = source
    this.cursor = new Cursor(tokens)
  }

  /** End (exclusive) of the logical line starting at `start`: brackets continue it across lines. */
  private statementEnd(start: number): number {
    const tokens = this.cursor.tokens
    let depth = 0
    let index = start
    for (; index < tokens.length; index++) {
      const token = tokens[index]
      if (index > start && depth === 0 && token.lineStart) break
      if (token.kind === 'punct') {
        if ('([{'.includes(token.value)) depth++
        else if (')]}'.includes(token.value)) depth = Math.max(0, depth - 1)
      }
    }
    return index
  }

  /** Statements of a block: those starting at the block's indentation, after `start`. */
  private block(start: number, parentColumn: number): Statement[] {
    const tokens = this.cursor.tokens
    const statements: Statement[] = []
    let index = start
    const column = tokens[index]?.column ?? 0
    if (!tokens[index] || column <= parentColumn) return statements
    while (index < tokens.length) {
      const token = tokens[index]
      if (token.lineStart && token.column <= parentColumn) break
      const end = this.statementEnd(index)
      if (token.column === column) statements.push({ start: index, end })
      index = end
    }
    return statements
  }

  run() {
    const tokens = this.cursor.tokens
    let decorators: Annotation[] = []
    let index = 0
    while (index < tokens.length) {
      const token = tokens[index]
      if (token.value === '@' && token.lineStart) {
        this.cursor.index = index
        const decorator = readAtAnnotation(this.cursor, this.source)
        if (decorator) decorators.push(decorator)
        index = this.statementEnd(index)
        continue
      }
      if (token.value === 'class' && token.kind === 'ident' && tokens[index + 1]?.kind === 'ident') {
        index = this.classDeclaration(index, decorators)
        decorators = []
        continue
      }
      decorators = []
      index = this.statementEnd(index)
    }
  }

  private classDeclaration(start: number, decorators: Annotation[]): number {
    const tokens = this.cursor.tokens
    const classToken = tokens[start]
    const name = tokens[start + 1].value
    const cursor = this.cursor
    cursor.index = start + 2
    const bases: { name: string; keyword?: string; value?: string }[] = []
    if (cursor.is('(')) {
      cursor.next()
      while (!cursor.done && !cursor.is(')')) {
        if (cursor.isIdent() && cursor.is('=', 1)) {
          const keyword = cursor.next().value
          cursor.next()
          bases.push({ name: '', keyword, value: cursor.value() })
          cursor.skipUntil([','])
        } else {
          const type = readType(cursor, SYNTAX)
          if (type) bases.push({ name: type.name })
          else cursor.next()
        }
        cursor.eat(',')
      }
      cursor.eat(')')
    }
    cursor.eat(':')
    const headerEnd = this.statementEnd(start)
    // `class A: pass` on one line
    if (cursor.index < headerEnd) return headerEnd

    const statements = this.block(headerEnd, classToken.column)
    const end = statements.length > 0 ? statements[statements.length - 1].end : headerEnd
    let description: string | undefined
    if (statements[0] && tokens[statements[0].start].kind === 'string' && statements[0].end === statements[0].start + 1) {
      description = tokens[statements[0].start].value.trim().split('\n')[0]
    }

    const baseNames = bases.map((base) => base.name.split('.').pop()!)
    if (baseNames.some((base) => ENUM_BASES.has(base))) {
      this.enumDeclaration(name, statements, description)
      return end
    }

    const model: RawModel = { name, kind: 'class', fields: [], construction: 'named' }
    if (description) model.description = description
    if (decorators.length > 0) model.annotations = decorators
    model.extends = bases.filter((base) => base.name !== '').map((base) => base.name)

    let framework: string | undefined
    if (decorators.some((item) => /^(dataclasses\.)?dataclass$/.test(item.name) || item.name === 'attr.s' || item.name === 'define'))
      framework = 'dataclass'
    if (baseNames.some((base) => base === 'BaseModel' || base === 'BaseSettings' || base === 'SQLModel')) framework = 'pydantic'
    if (baseNames.includes('TypedDict')) {
      framework = 'typeddict'
      model.kind = 'typeddict'
    }
    if (baseNames.includes('Model') && bases.some((base) => base.name === 'models.Model')) framework = 'django'
    if (baseNames.some((base) => base === 'Base' || base === 'DeclarativeBase')) framework = 'sqlalchemy'
    if (framework === 'django' || framework === 'sqlalchemy') model.kind = 'entity'
    if (framework) model.framework = framework
    const total = bases.find((base) => base.keyword === 'total')?.value !== 'False'

    for (const statement of statements) this.member(statement, model, framework, total)
    if (framework === 'django' && !model.fields.some((field) => field.metadata?.primaryKey)) {
      // Django adds an `id` primary key to every model that declares none
      model.fields.unshift({ name: 'id', type: { name: 'int', args: [] }, generated: true, metadata: { primaryKey: true } })
    }
    this.declarations.models.push(model)
    return end
  }

  private member(statement: Statement, model: RawModel, framework: string | undefined, total: boolean) {
    const tokens = this.cursor.tokens
    const cursor = this.cursor
    const first = tokens[statement.start]
    if (first.value === 'def' && tokens[statement.start + 1]?.value === '__init__') {
      this.initializer(statement, model)
      return
    }
    if (first.kind !== 'ident' || ['def', 'class', 'async', 'pass', 'return', 'if', 'for', 'with', 'from', 'import'].includes(first.value))
      return
    if (first.value.startsWith('__') || ['model_config', 'Config', 'Meta', 'objects'].includes(first.value)) return

    cursor.index = statement.start + 1
    let type: RawType | null = null
    let typeText: string | undefined
    if (cursor.eat(':')) {
      const typeStart = cursor.index
      type = normalize(readType(cursor, SYNTAX))
      typeText = cursor.textBetween(this.source, typeStart, cursor.index)
      if (type && ['ClassVar', 'typing.ClassVar'].includes(type.name)) return
    } else if (!cursor.is('=')) return
    const field: RawField = { name: first.value, type: this.literalEnum(type, first.value) }
    if (typeText) field.typeText = typeText
    if (first.doc) field.description = first.doc

    // TypedDict: missing keys are allowed when total=False or with NotRequired[...]
    if (framework === 'typeddict') {
      const annotation = typeText ?? ''
      if (!total || /^NotRequired\[/.test(annotation)) field.optional = true
    }

    if (cursor.eat('=')) {
      const valueStart = cursor.index
      const valueText = cursor.textBetween(this.source, valueStart, statement.end)
      const call = /^([\w.]+)\s*\(/.exec(valueText)
      if (call) {
        const callee = call[1].split('.').pop()!
        cursor.index = valueStart
        while (cursor.index < statement.end && !cursor.is('(')) cursor.next()
        const argsStart = cursor.index
        cursor.skipGroup()
        const args = cursor.textBetween(this.source, argsStart, cursor.index).slice(1, -1)
        const annotation: Annotation = { name: callee, args }
        if (!this.callInitializer(field, annotation, framework, callee)) return
      } else {
        const literal = parseLiteral(valueText)
        if (literal !== undefined) field.defaultValue = literal
        // Without an annotation, a plain class attribute is typed by its value
        if (!type && literal !== undefined && literal !== null) {
          field.type = {
            name: typeof literal === 'string' ? 'str' : typeof literal === 'boolean' ? 'bool' : Number.isInteger(literal) ? 'int' : 'float',
            args: [],
          }
        }
        if (literal === null && !type) field.type = { name: 'Any', args: [], nullable: true }
        if (valueText.trim() !== '' && framework !== 'typeddict') field.optional = true
      }
    }
    if (!field.type && !type) return
    model.fields.push(field)
  }

  /** `= Field(...)`, `= field(...)`, `= models.CharField(...)`, `= Column(...)`, `= mapped_column(...)`.
   * Returns false when the attribute is not a field (a relationship back-reference, a manager). */
  private callInitializer(field: RawField, call: Annotation, framework: string | undefined, callee: string): boolean {
    const args = call.args ?? ''
    const keyword = (name: string) => annotationArg(call, name)
    const hasKeyword = (name: string) => new RegExp(`(^|[\\s,(])${name}\\s*=`).test(args)
    field.annotations = [call]

    if (callee === 'Field' || callee === 'field') {
      const alias = keyword('alias') ?? keyword('serialization_alias') ?? keyword('validation_alias')
      if (alias) field.serializedName = alias
      const defaultText = keyword('default')
      const positional = /^\s*([^=,]+?)\s*(,|$)/.exec(args)?.[1]
      const defaultValue = defaultText ?? (positional && positional !== '...' ? positional : undefined)
      if (defaultValue !== undefined) {
        const literal = parseLiteral(defaultValue)
        if (literal !== undefined) field.defaultValue = literal
        field.optional = true
      }
      if (hasKeyword('default_factory')) field.optional = true
      const description = keyword('description')
      if (description) field.description = description
      return true
    }

    if (framework === 'django' || callee in DJANGO_FIELDS || ['ForeignKey', 'OneToOneField', 'ManyToManyField'].includes(callee)) {
      if (callee === 'ForeignKey' || callee === 'OneToOneField' || callee === 'ManyToManyField') {
        const target = /^\s*['"]?([\w.]+)['"]?/.exec(args)?.[1]?.split('.').pop() ?? 'Any'
        field.type = callee === 'ManyToManyField' ? { name: 'list', args: [{ name: target, args: [] }] } : { name: target, args: [] }
      } else if (callee in DJANGO_FIELDS) field.type ??= { name: DJANGO_FIELDS[callee], args: [] }
      else if (callee === 'Manager') return false
      if (keyword('null') === 'True') field.nullable = true
      if (keyword('blank') === 'True' || hasKeyword('default')) field.optional = true
      const defaultText = keyword('default')
      if (defaultText !== undefined) {
        const literal = parseLiteral(defaultText)
        if (literal !== undefined) field.defaultValue = literal
      }
      if (keyword('primary_key') === 'True') field.metadata = { primaryKey: true }
      if (/AutoField$/.test(callee) || keyword('auto_now') === 'True' || keyword('auto_now_add') === 'True') field.generated = true
      const column = keyword('db_column')
      if (column) field.serializedName = column
      return field.type !== null
    }

    if (callee === 'Column' || callee === 'mapped_column') {
      // Column(String(50), …) or mapped_column(String(50), …); the type may also come from Mapped[...]
      const typeName = /^\s*(?:['"][\w]+['"]\s*,\s*)?([A-Za-z_][\w.]*)/.exec(args)?.[1]?.split('.').pop()
      if (!field.type && typeName && typeName in SQLALCHEMY_TYPES) field.type = { name: SQLALCHEMY_TYPES[typeName], args: [] }
      const nullable = keyword('nullable')
      const primaryKey = keyword('primary_key') === 'True'
      if (callee === 'Column') field.nullable = nullable === 'True' || (nullable === undefined && !primaryKey)
      else if (nullable === 'True') field.nullable = true
      else if (nullable === 'False' && field.type) field.type = { ...field.type, nullable: false }
      if (primaryKey) {
        field.metadata = { primaryKey: true }
        if (keyword('autoincrement') !== 'False' && field.type?.name === 'int') field.generated = true
      }
      if (hasKeyword('server_default') || hasKeyword('default')) field.optional = true
      if (/onupdate|server_default\s*=\s*func\./.test(args) && /func\.now/.test(args)) field.generated = true
      const column = /^\s*['"]([\w]+)['"]/.exec(args)?.[1] ?? keyword('name')
      if (column) field.serializedName = column
      return field.type !== null
    }

    if (callee === 'relationship') return field.type !== null
    // Any other call: an initial value computed at run time
    field.optional = true
    return field.type !== null
  }

  /** Fields assigned in `__init__` (`self.name = name`), typed by the parameters' annotations. */
  private initializer(statement: Statement, model: RawModel) {
    const tokens = this.cursor.tokens
    const cursor = this.cursor
    cursor.index = statement.start + 2
    const params = new Map<string, { type: RawType | null; defaultValue?: string }>()
    if (cursor.eat('(')) {
      while (!cursor.done && !cursor.is(')')) {
        if (cursor.is('*') || cursor.is('/')) {
          cursor.next()
          cursor.eat(',')
          continue
        }
        if (!cursor.isIdent()) {
          cursor.next()
          continue
        }
        const name = cursor.next().value
        let type: RawType | null = null
        if (cursor.eat(':')) type = normalize(readType(cursor, SYNTAX))
        let defaultValue: string | undefined
        if (cursor.eat('=')) {
          const start = cursor.index
          cursor.skipUntil([','])
          defaultValue = cursor.textBetween(this.source, start, cursor.index)
        }
        if (name !== 'self') params.set(name, { type, defaultValue })
        cursor.eat(',')
      }
    }
    // The body follows the signature
    const signatureEnd = this.statementEnd(statement.start)
    for (let index = signatureEnd; index < tokens.length - 3; index++) {
      if (tokens[index].lineStart && tokens[index].column <= tokens[statement.start].column) break
      if (tokens[index].value !== 'self' || tokens[index + 1].value !== '.' || tokens[index + 2].kind !== 'ident') continue
      const name = tokens[index + 2].value
      let next = index + 3
      let type: RawType | null = null
      if (tokens[next]?.value === ':') {
        cursor.index = next + 1
        type = normalize(readType(cursor, SYNTAX))
        next = cursor.index
      }
      if (tokens[next]?.value !== '=' || model.fields.some((field) => field.name === name)) continue
      const value = tokens[next + 1]
      const param = value?.kind === 'ident' ? params.get(value.value) : undefined
      const field: RawField = { name, type: type ?? param?.type ?? null }
      if (param?.defaultValue !== undefined) {
        field.optional = true
        const literal = parseLiteral(param.defaultValue)
        if (literal !== undefined) field.defaultValue = literal
      }
      if (!field.type && value) {
        const literal = parseLiteral(value.kind === 'string' ? JSON.stringify(value.value) : value.value)
        if (typeof literal === 'string') field.type = { name: 'str', args: [] }
        else if (typeof literal === 'number') field.type = { name: Number.isInteger(literal) ? 'int' : 'float', args: [] }
        else if (typeof literal === 'boolean') field.type = { name: 'bool', args: [] }
      }
      if (name.startsWith('_')) continue
      model.fields.push(field)
    }
  }

  /** `status: Literal['active', 'blocked']` creates an enum named after the field. */
  private literalEnum(type: RawType | null, fieldName: string): RawType | null {
    if (!type || type.name !== '|') return type
    const literals = type.args.filter((arg) => arg.name.startsWith('"'))
    const others = type.args.filter((arg) => !arg.name.startsWith('"'))
    if (literals.length < 2 || others.some((arg) => arg.name !== 'None')) return type
    const used = new Set([...this.declarations.enums.map((item) => item.name), ...this.declarations.models.map((item) => item.name)])
    let name = toPascalCase(fieldName) || 'Value'
    for (let n = 2; used.has(name); n++) name = `${name}${n}`
    this.declarations.enums.push({ name, kind: 'literals', values: literals.map((arg) => ({ name: JSON.parse(arg.name) as string })) })
    const enumType: RawType = { name, args: [] }
    return others.length > 0 ? { name: '|', args: [enumType, ...others] } : enumType
  }

  private enumDeclaration(name: string, statements: Statement[], description: string | undefined) {
    const tokens = this.cursor.tokens
    const enumDef: RawEnum = { name, values: [] }
    if (description) enumDef.description = description
    let auto = 1
    for (const statement of statements) {
      const first = tokens[statement.start]
      if (first.kind !== 'ident' || tokens[statement.start + 1]?.value !== '=' || first.value.startsWith('_')) continue
      const value = tokens[statement.start + 2]
      const entry: RawEnum['values'][number] = { name: first.value }
      if (value?.kind === 'string') entry.value = value.value
      else if (value?.kind === 'number') entry.value = Number(value.value)
      else if (value?.value === 'auto') entry.value = auto++
      // Django choices: ACTIVE = 'A', 'Active'
      enumDef.values.push(entry)
    }
    this.declarations.enums.push(enumDef)
  }
}

export const pythonParser: InputParser = {
  id: 'python',
  kind: 'code',
  label: 'Python',
  extensions: ['.py', '.pyi'],
  editorLanguage: 'python',
  detect(text) {
    if (/^class\s+\w+(\([^)]*\))?\s*:\s*$/m.test(text))
      return /^\s+\w+\s*:\s*[\w[\]., |"']+(\s*=.*)?$/m.test(text) || /def __init__/.test(text) || /models\.\w+Field/.test(text) ? 0.95 : 0.7
    if (/^from\s+[\w.]+\s+import\s+/m.test(text) || /^@dataclass/m.test(text)) return 0.6
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
    const { schema, warnings } = buildSchema(reader.declarations, PYTHON_TYPES, 'python', 'python')
    return { ok: true, schema, warnings }
  },
}
