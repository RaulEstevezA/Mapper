import { MODEL_SCHEMA_FORMAT, MODEL_SCHEMA_VERSION, PRIMITIVES, type ModelSchema, type TypeRef } from '../../model/schema.ts'
import { failure, type InputParser, type ParseIssue } from '../types.ts'
import { readStructured } from './jsonSchema.ts'

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function validType(value: unknown, depth = 0): value is TypeRef {
  if (!isObject(value) || depth > 32) return false
  switch (value.kind) {
    case 'primitive':
      return PRIMITIVES.includes(value.name as never)
    case 'array':
      return validType(value.items, depth + 1)
    case 'map':
      return validType(value.key, depth + 1) && validType(value.value, depth + 1)
    case 'model':
    case 'enum':
    case 'unknown':
      return typeof value.name === 'string'
    default:
      return false
  }
}

/** Checks a document received from another tool or a file. Anything unexpected is rejected with the
 * path where it was found, instead of being trusted. */
export function validateModelSchema(value: unknown): { ok: true; schema: ModelSchema } | { ok: false; path: string } {
  if (!isObject(value)) return { ok: false, path: '$' }
  if (value.format !== MODEL_SCHEMA_FORMAT) return { ok: false, path: '$.format' }
  if (value.version !== MODEL_SCHEMA_VERSION) return { ok: false, path: '$.version' }
  if (!Array.isArray(value.models)) return { ok: false, path: '$.models' }
  const enums = value.enums ?? []
  if (!Array.isArray(enums)) return { ok: false, path: '$.enums' }
  for (const [index, model] of value.models.entries()) {
    if (!isObject(model) || typeof model.name !== 'string' || !Array.isArray(model.fields)) return { ok: false, path: `$.models[${index}]` }
    for (const [fieldIndex, field] of model.fields.entries()) {
      const path = `$.models[${index}].fields[${fieldIndex}]`
      if (!isObject(field) || typeof field.name !== 'string') return { ok: false, path }
      if (!validType(field.type)) return { ok: false, path: `${path}.type` }
      if (typeof field.nullable !== 'boolean' || typeof field.optional !== 'boolean') return { ok: false, path }
    }
  }
  for (const [index, item] of enums.entries()) {
    if (
      !isObject(item) ||
      typeof item.name !== 'string' ||
      !Array.isArray(item.values) ||
      !item.values.every((entry) => isObject(entry) && typeof entry.name === 'string')
    ) {
      return { ok: false, path: `$.enums[${index}]` }
    }
  }
  const schema = value as unknown as ModelSchema
  return {
    ok: true,
    schema: {
      ...schema,
      enums: enums as ModelSchema['enums'],
      models: schema.models.map((model) => ({ ...model, kind: model.kind ?? 'object' })),
    },
  }
}

/** A ModelSchema document, the format shared by Api2Class, Mapper and Model2DB (docs/interoperability.md). */
export const modelSchemaParser: InputParser = {
  id: 'modelschema',
  kind: 'schema',
  label: 'Model schema (Api2Class, Mapper)',
  extensions: ['.model.json'],
  editorLanguage: 'json',
  detect(text) {
    return /"format"\s*:\s*"model-schema"/.test(text.slice(0, 2000)) ? 1 : 0
  },
  parse(text) {
    const read = readStructured(text)
    if (!read.ok) return read.outcome
    const validated = validateModelSchema(read.value)
    if (!validated.ok) return failure('syntax', undefined, { detail: 'modelSchema', path: validated.path })
    if (validated.schema.models.length === 0) return failure('noModels')
    const warnings: ParseIssue[] = []
    return { ok: true, schema: validated.schema, warnings }
  },
}
