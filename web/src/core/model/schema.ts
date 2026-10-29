/** The language-neutral description of data models that every parser produces and every other part of
 * Mapper reads. It is also the interchange format with Api2Class and Model2DB (docs/interoperability.md),
 * so it only holds facts about the models, never mapping decisions. */

export const MODEL_SCHEMA_FORMAT = 'model-schema'
export const MODEL_SCHEMA_VERSION = 1

/** Scalar types shared by every language. `decimal` is an exact number (money), `float` a binary one.
 * `any` is a value of unknown shape (`object`, `dynamic`, `interface{}`). */
export type Primitive =
  'string' | 'integer' | 'float' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'time' | 'duration' | 'uuid' | 'binary' | 'any'

export const PRIMITIVES: readonly Primitive[] = [
  'string',
  'integer',
  'float',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'time',
  'duration',
  'uuid',
  'binary',
  'any',
]

export type TypeRef =
  /** `bits` is only known for sized numbers (`int32`, `Long`, `f32`); absent means "the usual size". */
  | { kind: 'primitive'; name: Primitive; bits?: 8 | 16 | 32 | 64 }
  | { kind: 'array'; items: TypeRef; itemsNullable?: boolean }
  | { kind: 'map'; key: TypeRef; value: TypeRef }
  /** Another model of the same schema, by name */
  | { kind: 'model'; name: string }
  | { kind: 'enum'; name: string }
  /** A type the parser could not resolve: a class declared elsewhere, a generic parameter */
  | { kind: 'unknown'; name: string }

export type Literal = string | number | boolean | null

/** An annotation, decorator or attribute kept because it says something about the field
 * (`@Column(nullable = false)`, `[JsonPropertyName("id")]`). `args` is the raw text between parentheses. */
export interface Annotation {
  name: string
  args?: string
}

export interface FieldDef {
  name: string
  type: TypeRef
  /** The type exactly as written in the input (`Optional[List[str]]`, `int?`), for display */
  originalType?: string
  /** May hold null (`String?`, `Optional[str]`, `string | null`, `nullable: true`) */
  nullable: boolean
  /** May be missing (`name?: string`, not in `required`, `omitempty`) */
  optional: boolean
  /** Value used when none is given; undefined when the input declares no default */
  defaultValue?: Literal
  /** Name on the wire or in the database, when it differs from the field name (`@JsonProperty("user_id")`) */
  serializedName?: string
  /** Other names the field is known by (`AliasChoices`, `@JsonAlias`) */
  aliases?: string[]
  description?: string
  annotations?: Annotation[]
  /** Computed or generated (`@GeneratedValue`, `readonly`, `@property`): it never needs a value from a mapping */
  generated?: boolean
  metadata?: Record<string, string | number | boolean>
}

export type ModelKind =
  'class' | 'record' | 'struct' | 'interface' | 'type' | 'object' | 'entity' | 'message' | 'input' | 'table' | 'typeddict'

/** How an instance of the model is built, for the generators: with named arguments
 * (`User(id=1)`, `User(id: 1)`), positional ones (`new User(1)`), or by setting properties. */
export type ConstructionStyle = 'named' | 'positional' | 'properties'

export interface ModelDef {
  name: string
  /** Package, namespace or module (`com.example.dto`, `App\\Models`) */
  namespace?: string
  kind: ModelKind
  fields: FieldDef[]
  /** Generic parameters of the model (`Page<T>`) */
  generics?: string[]
  /** Parent models whose fields are inherited; `allFields` includes them */
  extends?: string[]
  /** Framework the model belongs to, when recognized (`pydantic`, `jpa`, `django`, `typeorm`) */
  framework?: string
  construction?: ConstructionStyle
  description?: string
  annotations?: Annotation[]
  metadata?: Record<string, string | number | boolean>
}

export interface EnumValue {
  name: string
  /** Value on the wire when it differs from the name (`ACTIVE = "active"`, `PAID = 2`) */
  value?: string | number
  description?: string
}

export interface EnumDef {
  name: string
  namespace?: string
  values: EnumValue[]
  /** `literals`: a set of allowed values without an enum type of its own (`'a' | 'b'` in TypeScript,
   * `Literal[...]` in Python, `enum` in JSON Schema). Code writes them as plain values. */
  kind?: 'enum' | 'literals'
  description?: string
}

/** Where a schema comes from: the input format, and the language and framework when it is code. */
export interface SchemaOrigin {
  format: string
  language?: string
  framework?: string
  /** Tool that produced it, for schemas received from another tool (`api2class`) */
  tool?: string
}

export interface ModelSchema {
  format: typeof MODEL_SCHEMA_FORMAT
  version: typeof MODEL_SCHEMA_VERSION
  origin?: SchemaOrigin
  /** In the order they appear in the input */
  models: ModelDef[]
  enums: EnumDef[]
  /** The model the input is mainly about (the root of a JSON document); the first model otherwise */
  root?: string
}

export function emptySchema(origin?: SchemaOrigin): ModelSchema {
  return { format: MODEL_SCHEMA_FORMAT, version: MODEL_SCHEMA_VERSION, origin, models: [], enums: [] }
}

export function findModel(schema: ModelSchema, name: string): ModelDef | undefined {
  return schema.models.find((model) => model.name === name)
}

export function findEnum(schema: ModelSchema, name: string): EnumDef | undefined {
  return schema.enums.find((item) => item.name === name)
}

/** Fields of a model including the inherited ones, parents first; a field redeclared in a child wins. */
export function allFields(schema: ModelSchema, model: ModelDef, seen: Set<string> = new Set()): FieldDef[] {
  if (seen.has(model.name)) return model.fields
  seen.add(model.name)
  const inherited = (model.extends ?? []).flatMap((parent) => {
    const found = findModel(schema, parent)
    return found ? allFields(schema, found, seen) : []
  })
  const own = new Set(model.fields.map((field) => field.name))
  return [...inherited.filter((field) => !own.has(field.name)), ...model.fields]
}

/** A target field that must receive a value: it cannot be missing or null and has no default. */
export function needsValue(field: FieldDef): boolean {
  return !field.optional && !field.nullable && field.defaultValue === undefined && !field.generated
}

/** The model chosen by default: the declared root, or the model no other model refers to, or the first. */
export function defaultRoot(schema: ModelSchema): string | undefined {
  if (schema.root && findModel(schema, schema.root)) return schema.root
  const referenced = new Set<string>()
  for (const model of schema.models) {
    for (const field of model.fields) {
      const inner = modelOf(field.type)
      if (inner && inner !== model.name) referenced.add(inner)
    }
  }
  return (schema.models.find((model) => !referenced.has(model.name) && model.fields.length > 0) ?? schema.models[0])?.name
}

/** The model a type leads to, directly or through arrays and maps (`Order[]` → `Order`). */
export function modelOf(type: TypeRef): string | null {
  if (type.kind === 'model') return type.name
  if (type.kind === 'array') return modelOf(type.items)
  if (type.kind === 'map') return modelOf(type.value)
  return null
}

/** Language-neutral description of a type for the interface: `integer`, `Order[]`, `map<string, float>`. */
export function describeType(type: TypeRef): string {
  switch (type.kind) {
    case 'primitive':
      return type.bits && (type.name === 'integer' || type.name === 'float') ? `${type.name}${type.bits}` : type.name
    case 'array':
      return type.itemsNullable ? `(${describeType(type.items)} | null)[]` : `${describeType(type.items)}[]`
    case 'map':
      return `map<${describeType(type.key)}, ${describeType(type.value)}>`
    case 'model':
    case 'enum':
    case 'unknown':
      return type.name
  }
}

export function primitive(name: Primitive, bits?: 8 | 16 | 32 | 64): TypeRef {
  return bits ? { kind: 'primitive', name, bits } : { kind: 'primitive', name }
}

export function sameType(a: TypeRef, b: TypeRef): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
