import { toPascalCase, uniqueName } from '../../model/naming.ts'
import {
  emptySchema,
  primitive,
  type EnumDef,
  type FieldDef,
  type Literal,
  type ModelDef,
  type ModelSchema,
  type TypeRef,
} from '../../model/schema.ts'
import { parseJson } from '../data/jsonText.ts'
import { readYaml } from '../data/yaml.ts'
import { failure, type InputParser, type ParseIssue, type ParseOutcome } from '../types.ts'

/** Converts JSON Schema (draft 4 to 2020-12) and the schema objects of OpenAPI and Swagger into models.
 * `$ref`s to definitions become references to the model of that definition. */

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads JSON, and YAML when it is not JSON: schemas are written in both. */
export function readStructured(text: string): { ok: true; value: unknown } | { ok: false; outcome: ParseOutcome } {
  if (text.trim() === '') return { ok: false, outcome: failure('empty') }
  const start = text.trimStart()[0]
  if (start === '{' || start === '[') {
    const parsed = parseJson(text)
    if (!parsed.ok) {
      const { line, column, code, found, expected, key } = parsed.error
      const params: Record<string, string> = { detail: `json.${code}` }
      if (found !== undefined) params.found = found
      if (expected) params.expected = expected
      if (key !== undefined) params.key = key
      return { ok: false, outcome: failure('syntax', { line, column }, params) }
    }
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, '')) as unknown }
  }
  return readYaml(text)
}

interface Context {
  /** Definitions by the path a `$ref` uses (`#/$defs/Address`, `#/components/schemas/Address`) */
  definitions: Map<string, { name: string; schema: Json }>
  models: ModelDef[]
  enums: EnumDef[]
  usedNames: Set<string>
  /** Definition paths already converted (or being converted) */
  converted: Set<string>
  warnings: ParseIssue[]
}

const FORMAT_TYPES: Record<string, TypeRef> = {
  'date-time': primitive('datetime'),
  date: primitive('date'),
  time: primitive('time'),
  duration: primitive('duration'),
  uuid: primitive('uuid'),
  byte: primitive('binary'),
  binary: primitive('binary'),
  int32: primitive('integer', 32),
  int64: primitive('integer', 64),
  float: primitive('float', 32),
  double: primitive('float', 64),
  decimal: primitive('decimal'),
}

function literal(value: unknown): Literal | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return undefined
}

/** `type: ["string", "null"]`, `nullable: true` (OpenAPI 3.0), `x-nullable` (Swagger) or `oneOf` with null. */
function typesOf(schema: Json): { types: string[]; nullable: boolean } {
  const raw = schema.type
  const types = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : typeof raw === 'string' ? [raw] : []
  const nullable = types.includes('null') || schema.nullable === true || schema['x-nullable'] === true
  return { types: types.filter((item) => item !== 'null'), nullable }
}

function refTarget(ref: string, context: Context): string | null {
  const definition = context.definitions.get(ref)
  if (!definition) return null
  if (!context.converted.has(ref)) {
    context.converted.add(ref)
    convertDefinition(definition.name, definition.schema, context)
  }
  return definition.name
}

/** A definition that is not an object or an enum (an alias of string) creates no model of its own. */
function convertDefinition(name: string, schema: Json, context: Context) {
  convertType(schema, name, context, true)
}

interface Converted {
  type: TypeRef
  nullable: boolean
}

/** Type of a schema. `named` is set for definitions: an object or enum is created with that exact name. */
function convertType(schema: Json, nameHint: string, context: Context, named = false): Converted {
  if (typeof schema.$ref === 'string') {
    const target = refTarget(schema.$ref, context)
    if (target) {
      const definition = context.definitions.get(schema.$ref)!
      const kind = context.enums.some((item) => item.name === target)
        ? 'enum'
        : context.models.some((item) => item.name === target)
          ? 'model'
          : null
      if (kind) return { type: { kind, name: target }, nullable: false }
      // An alias definition (`Id: {type: string}`): use what it stands for
      return convertType(definition.schema, nameHint, context)
    }
    context.warnings.push({ code: 'unknownType', params: { type: schema.$ref, field: nameHint } })
    return { type: primitive('any'), nullable: false }
  }

  const { types, nullable } = typesOf(schema)

  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = schema[key]
    if (Array.isArray(options)) {
      const nonNull = options.filter((option) => isObject(option) && !(option.type === 'null'))
      const hasNull = nonNull.length < options.length
      if (nonNull.length === 1) {
        const inner = convertType(nonNull[0] as Json, nameHint, context, named)
        return { type: inner.type, nullable: inner.nullable || hasNull || nullable }
      }
      if (nonNull.length > 1) return { type: primitive('any'), nullable: hasNull || nullable }
    }
  }

  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((value) => value !== null)
    const enumNullable = values.length < schema.enum.length || nullable
    if (values.every((value) => typeof value === 'string' || typeof value === 'number')) {
      const name = named ? nameHint : uniqueName(toPascalCase(nameHint) || 'Enum', context.usedNames)
      if (named) context.usedNames.add(name)
      const enumDef: EnumDef = {
        name,
        kind: 'literals',
        values: values.map((value) => ({ name: String(value), ...(typeof value === 'number' ? { value } : {}) })),
      }
      if (typeof schema.description === 'string') enumDef.description = schema.description
      context.enums.push(enumDef)
      return { type: { kind: 'enum', name }, nullable: enumNullable }
    }
  }

  const type =
    types[0] ?? (isObject(schema.properties) || Array.isArray(schema.allOf) ? 'object' : isObject(schema.items) ? 'array' : undefined)
  if (type === 'array') {
    const items = isObject(schema.items)
      ? convertType(schema.items, `${nameHint}Item`, context)
      : { type: primitive('any'), nullable: false }
    const array: TypeRef = { kind: 'array', items: items.type }
    if (items.nullable) array.itemsNullable = true
    return { type: array, nullable }
  }
  if (type === 'object') {
    const hasProperties = isObject(schema.properties) || Array.isArray(schema.allOf)
    if (!hasProperties) {
      const value = isObject(schema.additionalProperties)
        ? convertType(schema.additionalProperties, `${nameHint}Value`, context).type
        : primitive('any')
      return { type: { kind: 'map', key: primitive('string'), value }, nullable }
    }
    const name = named
      ? nameHint
      : uniqueName(toPascalCase(typeof schema.title === 'string' ? schema.title : nameHint) || 'Model', context.usedNames)
    if (named) context.usedNames.add(name)
    buildModel(name, schema, context)
    return { type: { kind: 'model', name }, nullable }
  }
  if (type === 'string') {
    const format = typeof schema.format === 'string' ? FORMAT_TYPES[schema.format] : undefined
    return {
      type: format && format.kind === 'primitive' && !['integer', 'float'].includes(format.name) ? format : primitive('string'),
      nullable,
    }
  }
  if (type === 'integer') {
    const format = typeof schema.format === 'string' ? FORMAT_TYPES[schema.format] : undefined
    return { type: format?.kind === 'primitive' && format.name === 'integer' ? format : primitive('integer'), nullable }
  }
  if (type === 'number') {
    const format = typeof schema.format === 'string' ? FORMAT_TYPES[schema.format] : undefined
    return {
      type: format?.kind === 'primitive' && (format.name === 'float' || format.name === 'decimal') ? format : primitive('float'),
      nullable,
    }
  }
  if (type === 'boolean') return { type: primitive('boolean'), nullable }
  return { type: primitive('any'), nullable }
}

function buildModel(name: string, schema: Json, context: Context) {
  const model: ModelDef = { name, kind: 'object', fields: [] }
  if (typeof schema.description === 'string') model.description = schema.description
  context.models.push(model)
  const parts = Array.isArray(schema.allOf) ? schema.allOf.filter(isObject) : []
  for (const part of [...parts, schema]) {
    if (part !== schema && typeof part.$ref === 'string') {
      const parent = refTarget(part.$ref, context)
      if (parent && context.models.some((item) => item.name === parent)) {
        model.extends = [...(model.extends ?? []), parent]
        continue
      }
    }
    const required = new Set(Array.isArray(part.required) ? part.required.filter((item): item is string => typeof item === 'string') : [])
    const properties = isObject(part.properties) ? part.properties : {}
    for (const [key, property] of Object.entries(properties)) {
      if (!isObject(property)) continue
      if (model.fields.some((field) => field.name === key)) {
        context.warnings.push({ code: 'duplicateField', params: { model: name, field: key } })
        continue
      }
      const converted = convertType(property, key, context)
      const field: FieldDef = { name: key, type: converted.type, nullable: converted.nullable, optional: !required.has(key) }
      const defaultValue = literal(property.default)
      if (defaultValue !== undefined) field.defaultValue = defaultValue
      if (typeof property.description === 'string') field.description = property.description
      if (property.readOnly === true) field.generated = true
      if (typeof property.format === 'string') field.originalType = `${String(property.type ?? '')}(${property.format})`
      model.fields.push(field)
    }
  }
}

/** Models of a schema document. `definitions` lists where the named schemas are, by the prefix their
 * `$ref`s use; `root` is the top-level schema, when the document itself is one. */
export function convertSchemas(
  definitions: { prefix: string; schemas: unknown }[],
  root: Json | null,
  rootName: string,
  format: string,
): { schema: ModelSchema; warnings: ParseIssue[] } {
  const context: Context = { definitions: new Map(), models: [], enums: [], usedNames: new Set(), converted: new Set(), warnings: [] }
  for (const { prefix, schemas } of definitions) {
    if (!isObject(schemas)) continue
    for (const [key, schema] of Object.entries(schemas)) {
      if (isObject(schema)) context.definitions.set(`${prefix}${key}`, { name: toPascalCase(key) || key, schema })
    }
  }
  // Names of definitions are reserved first, so inline models never take them
  for (const { name } of context.definitions.values()) context.usedNames.add(name)

  let rootModel: string | undefined
  if (root && (isObject(root.properties) || Array.isArray(root.allOf) || root.type === 'object')) {
    const name = typeof root.title === 'string' ? toPascalCase(root.title) || rootName : rootName
    const finalName = uniqueName(name, context.usedNames)
    const converted = convertType(root, finalName, context, true)
    if (converted.type.kind === 'model') rootModel = converted.type.name
  }
  for (const [path, definition] of context.definitions) {
    if (!context.converted.has(path)) {
      context.converted.add(path)
      convertDefinition(definition.name, definition.schema, context)
    }
  }
  const schema: ModelSchema = { ...emptySchema({ format }), models: context.models, enums: context.enums }
  if (rootModel) schema.root = rootModel
  return { schema, warnings: context.warnings }
}

export const jsonSchemaParser: InputParser = {
  id: 'jsonschema',
  kind: 'schema',
  label: 'JSON Schema',
  extensions: ['.schema.json'],
  editorLanguage: 'json',
  detect(text) {
    const head = text.slice(0, 4000)
    if (/["']?\$schema["']?\s*:\s*["']?https?:\/\/json-schema\.org/.test(head)) return 0.98
    if (/["']?(\$defs|definitions)["']?\s*:/.test(head) && /["']?properties["']?\s*:/.test(head)) return 0.85
    if (/"type"\s*:\s*"object"/.test(head) && /"properties"\s*:\s*\{/.test(head)) return 0.85
    return 0
  },
  parse(text, options = {}) {
    const read = readStructured(text)
    if (!read.ok) return read.outcome
    if (!isObject(read.value)) return failure('noModels')
    const document = read.value
    const { schema, warnings } = convertSchemas(
      [
        { prefix: '#/$defs/', schemas: document.$defs },
        { prefix: '#/definitions/', schemas: document.definitions },
      ],
      document,
      options.rootName ?? 'Root',
      'jsonschema',
    )
    if (schema.models.length === 0) return failure('noModels')
    return { ok: true, schema, warnings }
  },
}
