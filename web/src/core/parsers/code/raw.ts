import {
  emptySchema,
  primitive,
  type Annotation,
  type ConstructionStyle,
  type EnumDef,
  type FieldDef,
  type Literal,
  type ModelDef,
  type ModelKind,
  type ModelSchema,
  type TypeRef,
} from '../../model/schema.ts'
import type { ParseIssue } from '../types.ts'

/** What a declaration parser reads, before types are resolved. Parsers only deal with syntax; the
 * language's TypeTable turns type names into the common types (docs/adding-a-language.md). */

/** A type as written. Arrays are `[]` with one argument and inline maps `{}` with key and value
 * (`[]string`, `[K: V]`, `map[K]V`); unions are `|` (`string | null`). Generic types keep their name and
 * arguments (`List<String>` → name `List`, args [String]). */
export interface RawType {
  name: string
  args: RawType[]
  /** Marked nullable by the syntax itself (`String?`, `?string`, `*int`) */
  nullable?: boolean
}

export interface RawField {
  name: string
  type: RawType | null
  /** The type as written, for display */
  typeText?: string
  optional?: boolean
  nullable?: boolean
  defaultValue?: Literal
  serializedName?: string
  aliases?: string[]
  description?: string
  annotations?: Annotation[]
  generated?: boolean
  metadata?: Record<string, string | number | boolean>
}

export interface RawModel {
  name: string
  kind: ModelKind
  fields: RawField[]
  namespace?: string
  generics?: string[]
  extends?: string[]
  framework?: string
  construction?: ConstructionStyle
  description?: string
  annotations?: Annotation[]
  metadata?: Record<string, string | number | boolean>
}

export interface RawEnum {
  name: string
  kind?: 'enum' | 'literals'
  values: { name: string; value?: string | number; description?: string }[]
  namespace?: string
  description?: string
}

export interface RawDeclarations {
  models: RawModel[]
  enums: RawEnum[]
  /** Type aliases (`type Id = string`): resolved to what they stand for */
  aliases?: Map<string, RawType>
  warnings: ParseIssue[]
}

/** Names of a language's types. Keys are matched after dropping any namespace (`java.util.List` → `List`). */
export interface TypeTable {
  primitives: Record<string, TypeRef>
  /** Primitives that can also hold null (Java `Integer`, C# `Nullable`-free reference types are not here) */
  nullablePrimitives?: Record<string, TypeRef>
  /** Generic collections whose first argument is the element type */
  lists: readonly string[]
  /** Generic maps: key and value types */
  maps: readonly string[]
  /** Wrappers meaning "may be null or missing": `Optional<T>`, `Option<T>`, `Nullable<T>` */
  optionals: readonly string[]
  /** Wrappers that do not change the type (`Mapped[T]`, `Box<T>`, `Promise`-free `Readonly<T>`) */
  transparent?: readonly string[]
  /** Names that mean "no value", allowed in unions (`null`, `None`, `undefined`, `nil`) */
  nullNames?: readonly string[]
  caseInsensitive?: boolean
}

function simpleName(name: string): string {
  return name.split(/\.|::|\\/).pop() ?? name
}

interface Resolved {
  type: TypeRef
  nullable: boolean
}

export class TypeResolver {
  private readonly table: TypeTable
  private readonly models: Set<string>
  private readonly enums: Set<string>
  private readonly aliases: Map<string, RawType>
  readonly unknown = new Set<string>()

  constructor(table: TypeTable, declarations: RawDeclarations) {
    this.table = table
    this.models = new Set(declarations.models.map((model) => model.name))
    this.enums = new Set(declarations.enums.map((item) => item.name))
    this.aliases = declarations.aliases ?? new Map()
  }

  private lookup<T>(record: Record<string, T> | undefined, name: string): T | undefined {
    if (!record) return undefined
    if (name in record) return record[name]
    const simple = simpleName(name)
    if (simple in record) return record[simple]
    if (this.table.caseInsensitive) {
      const lower = simple.toLowerCase()
      const key = Object.keys(record).find((item) => item.toLowerCase() === lower)
      if (key) return record[key]
    }
    return undefined
  }

  private matches(list: readonly string[] | undefined, name: string): boolean {
    if (!list) return false
    const simple = simpleName(name)
    return (
      list.includes(name) ||
      list.includes(simple) ||
      (this.table.caseInsensitive === true && list.some((item) => item.toLowerCase() === simple.toLowerCase()))
    )
  }

  resolve(raw: RawType | null, depth = 0): Resolved {
    if (!raw || depth > 32) return { type: primitive('any'), nullable: false }
    const result = this.resolveInner(raw, depth)
    return raw.nullable ? { ...result, nullable: true } : result
  }

  private resolveInner(raw: RawType, depth: number): Resolved {
    const { name, args } = raw
    if (name === '[]') {
      const items = this.resolve(args[0] ?? null, depth + 1)
      const type: TypeRef = { kind: 'array', items: items.type }
      if (items.nullable) type.itemsNullable = true
      return { type, nullable: false }
    }
    if (name === '{}') {
      return {
        type: { kind: 'map', key: this.resolve(args[0] ?? null, depth + 1).type, value: this.resolve(args[1] ?? null, depth + 1).type },
        nullable: false,
      }
    }
    if (name === '|') {
      const nullNames = this.table.nullNames ?? []
      const options = args.filter((option) => !nullNames.includes(option.name))
      const nullable = options.length < args.length
      if (options.length === 1) {
        const inner = this.resolve(options[0], depth + 1)
        return { type: inner.type, nullable: inner.nullable || nullable }
      }
      return { type: primitive('any'), nullable }
    }
    if (name === '&') {
      // An intersection (`Base & { extra: string }`): its first named part is the best description
      const parts = args.map((part) => this.resolve(part, depth + 1))
      return parts.find((part) => part.type.kind === 'model') ?? parts[0] ?? { type: primitive('any'), nullable: false }
    }
    // A type that is only null (`notes: None`, `notes: null`): a value of unknown shape that is always missing
    if (args.length === 0 && (this.table.nullNames ?? []).includes(name)) return { type: primitive('any'), nullable: true }
    if (this.matches(this.table.optionals, name) && args.length === 1) {
      return { type: this.resolve(args[0], depth + 1).type, nullable: true }
    }
    if (this.matches(this.table.transparent, name) && args.length === 1) return this.resolve(args[0], depth + 1)
    if (this.matches(this.table.lists, name)) {
      const items = this.resolve(args[0] ?? null, depth + 1)
      const type: TypeRef = { kind: 'array', items: items.type }
      if (items.nullable) type.itemsNullable = true
      return { type, nullable: false }
    }
    if (this.matches(this.table.maps, name)) {
      const key = args.length >= 2 ? this.resolve(args[0], depth + 1).type : primitive('string')
      const value = this.resolve(args.length >= 2 ? args[1] : null, depth + 1).type
      return { type: { kind: 'map', key, value }, nullable: false }
    }
    const nullablePrimitive = this.lookup(this.table.nullablePrimitives, name)
    if (nullablePrimitive) return { type: nullablePrimitive, nullable: true }
    const primitiveType = this.lookup(this.table.primitives, name)
    if (primitiveType) return { type: primitiveType, nullable: false }
    const simple = simpleName(name)
    if (this.models.has(name) || this.models.has(simple))
      return { type: { kind: 'model', name: this.models.has(name) ? name : simple }, nullable: false }
    if (this.enums.has(name) || this.enums.has(simple))
      return { type: { kind: 'enum', name: this.enums.has(name) ? name : simple }, nullable: false }
    const alias = this.aliases.get(name) ?? this.aliases.get(simple)
    if (alias && depth < 16) return this.resolve(alias, depth + 1)
    this.unknown.add(name)
    return { type: { kind: 'unknown', name: simple }, nullable: false }
  }
}

/** Writes a raw type back as text (`List<String>`), for display when the parser kept no original text. */
export function typeText(raw: RawType | null): string {
  if (!raw) return ''
  let text: string
  if (raw.name === '[]') text = `${typeText(raw.args[0] ?? null)}[]`
  else if (raw.name === '{}') text = `{${typeText(raw.args[0] ?? null)}: ${typeText(raw.args[1] ?? null)}}`
  else if (raw.name === '|') text = raw.args.map(typeText).join(' | ')
  else text = raw.args.length > 0 ? `${raw.name}<${raw.args.map(typeText).join(', ')}>` : raw.name
  return raw.nullable ? `${text}?` : text
}

/** Resolves the types of the declarations and builds the schema. */
export function buildSchema(
  declarations: RawDeclarations,
  table: TypeTable,
  format: string,
  language: string,
): { schema: ModelSchema; warnings: ParseIssue[] } {
  const resolver = new TypeResolver(table, declarations)
  const warnings = [...declarations.warnings]
  const generics = new Map(declarations.models.map((model) => [model.name, new Set(model.generics ?? [])]))
  const frameworks = new Set<string>()

  const models: ModelDef[] = declarations.models.map((raw) => {
    if (raw.framework) frameworks.add(raw.framework)
    const seen = new Set<string>()
    const fields: FieldDef[] = []
    for (const rawField of raw.fields) {
      if (seen.has(rawField.name)) {
        warnings.push({ code: 'duplicateField', params: { model: raw.name, field: rawField.name } })
        continue
      }
      seen.add(rawField.name)
      const own = generics.get(raw.name)!
      // A generic parameter of the model (`T data`) is a value of unknown shape
      const resolved =
        rawField.type && own.has(rawField.type.name) && rawField.type.args.length === 0
          ? { type: { kind: 'unknown', name: rawField.type.name } as TypeRef, nullable: rawField.type.nullable === true }
          : resolver.resolve(rawField.type)
      const field: FieldDef = {
        name: rawField.name,
        type: resolved.type,
        nullable: resolved.nullable || rawField.nullable === true,
        optional: rawField.optional === true,
      }
      const original = rawField.typeText ?? (rawField.type ? typeText(rawField.type) : undefined)
      if (original) field.originalType = original
      for (const key of ['defaultValue', 'serializedName', 'aliases', 'description', 'annotations', 'generated', 'metadata'] as const) {
        const value = rawField[key]
        if (value !== undefined && !(Array.isArray(value) && value.length === 0)) (field as unknown as Record<string, unknown>)[key] = value
      }
      fields.push(field)
    }
    const model: ModelDef = { name: raw.name, kind: raw.kind, fields }
    for (const key of [
      'namespace',
      'generics',
      'extends',
      'framework',
      'construction',
      'description',
      'annotations',
      'metadata',
    ] as const) {
      const value = raw[key]
      if (value !== undefined && !(Array.isArray(value) && value.length === 0)) (model as unknown as Record<string, unknown>)[key] = value
    }
    return model
  })

  // Keep only parents that are part of the input: others (BaseModel, Object) carry no known fields
  const known = new Set(models.map((model) => model.name))
  for (const model of models) {
    if (model.extends) {
      model.extends = model.extends.filter((parent) => known.has(parent))
      if (model.extends.length === 0) delete model.extends
    }
  }

  const enums: EnumDef[] = declarations.enums.map((raw) => {
    const item: EnumDef = { name: raw.name, values: raw.values }
    if (raw.kind) item.kind = raw.kind
    if (raw.namespace) item.namespace = raw.namespace
    if (raw.description) item.description = raw.description
    return item
  })

  // Duplicate declarations (two classes with the same name): the first one wins
  const unique: ModelDef[] = []
  for (const model of models) {
    if (unique.some((item) => item.name === model.name)) warnings.push({ code: 'duplicateModel', params: { model: model.name } })
    else unique.push(model)
  }

  for (const name of resolver.unknown) warnings.push({ code: 'unknownType', params: { type: name } })
  const framework = frameworks.size === 1 ? [...frameworks][0] : undefined
  return { schema: { ...emptySchema({ format, language, ...(framework ? { framework } : {}) }), models: unique, enums }, warnings }
}

/** Parses a literal written in code (`"x"`, `42`, `true`, `None`) for default values. Expressions return undefined. */
export function parseLiteral(text: string): Literal | undefined {
  const value = text.trim()
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if (/^(true|True|TRUE)$/.test(value)) return true
  if (/^(false|False|FALSE)$/.test(value)) return false
  if (/^(null|None|nil|NULL|undefined)$/.test(value)) return null
  const quoted = /^(["'])(.*)\1$/s.exec(value)
  if (quoted) return quoted[2]
  return undefined
}
