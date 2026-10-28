import { singularize, toPascalCase, uniqueName } from '../../model/naming.ts'
import { emptySchema, primitive, type FieldDef, type ModelDef, type ModelSchema, type Primitive, type TypeRef } from '../../model/schema.ts'
import type { ParseIssue } from '../types.ts'
import type { JsonValue } from './jsonText.ts'

/** Infers models from an example document (JSON, YAML, XML or CSV, all read as a JsonValue). Arrays of
 * objects are merged, so a key missing in some items is optional and a key that is null in some is nullable. */

type StringFormat = 'date' | 'datetime' | 'time' | 'uuid'

interface ValueStats {
  count: number
  nulls: number
  strings: number
  /** Formats every string seen so far matches; emptied by the first plain text */
  formats: Set<StringFormat> | null
  integers: number
  floats: number
  booleans: number
  object: ObjectStats | null
  /** Elements of the arrays seen at this place */
  array: ValueStats | null
  arrays: number
}

interface ObjectStats {
  count: number
  keys: Map<string, { present: number; stats: ValueStats }>
}

const FORMATS: [StringFormat, RegExp][] = [
  ['datetime', /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/],
  ['date', /^\d{4}-\d{2}-\d{2}$/],
  ['time', /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/],
  ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
]

function emptyStats(): ValueStats {
  return { count: 0, nulls: 0, strings: 0, formats: null, integers: 0, floats: 0, booleans: 0, object: null, array: null, arrays: 0 }
}

function stringFormats(value: string): Set<StringFormat> {
  return new Set(FORMATS.filter(([, pattern]) => pattern.test(value)).map(([format]) => format))
}

function collect(stats: ValueStats, value: JsonValue) {
  stats.count++
  switch (value.kind) {
    case 'null':
      stats.nulls++
      break
    case 'string': {
      const formats = stringFormats(value.value)
      stats.formats = stats.strings === 0 ? formats : new Set([...(stats.formats ?? [])].filter((format) => formats.has(format)))
      stats.strings++
      break
    }
    case 'number':
      if (value.integer) stats.integers++
      else stats.floats++
      break
    case 'boolean':
      stats.booleans++
      break
    case 'array':
      stats.arrays++
      stats.array ??= emptyStats()
      for (const item of value.items) collect(stats.array, item)
      break
    case 'object': {
      stats.object ??= { count: 0, keys: new Map() }
      stats.object.count++
      const seen = new Set<string>()
      for (const [key, child] of value.entries) {
        // A repeated key: JSON.parse would keep the last one; it is the same field either way
        if (seen.has(key)) continue
        seen.add(key)
        let entry = stats.object.keys.get(key)
        if (!entry) {
          entry = { present: 0, stats: emptyStats() }
          stats.object.keys.set(key, entry)
        }
        entry.present++
        collect(entry.stats, child)
      }
      break
    }
  }
}

interface Context {
  models: ModelDef[]
  usedNames: Set<string>
  warnings: ParseIssue[]
}

function scalarType(stats: ValueStats, path: string, context: Context): TypeRef {
  const kinds = [stats.strings > 0, stats.integers + stats.floats > 0, stats.booleans > 0, stats.object !== null, stats.arrays > 0].filter(
    Boolean,
  ).length
  if (kinds === 0) return primitive('any')
  if (kinds > 1) {
    context.warnings.push({ code: 'mixedTypes', params: { field: path } })
    return primitive('any')
  }
  if (stats.strings > 0) {
    const format = stats.formats && FORMATS.map(([name]) => name).find((name) => stats.formats!.has(name))
    return primitive((format as Primitive | undefined) ?? 'string')
  }
  if (stats.floats > 0) return primitive('float')
  if (stats.integers > 0) return primitive('integer')
  return primitive('boolean')
}

function resolve(stats: ValueStats, nameHint: string, path: string, context: Context): { type: TypeRef; itemsNullable?: boolean } {
  if (stats.object && stats.strings + stats.integers + stats.floats + stats.booleans + stats.arrays === 0) {
    return { type: { kind: 'model', name: buildModel(stats.object, nameHint, path, context) } }
  }
  if (stats.array && stats.strings + stats.integers + stats.floats + stats.booleans === 0 && !stats.object) {
    const items = stats.array
    const itemName = singularName(nameHint)
    const inner = resolve(items, itemName, `${path}[]`, context)
    const type: TypeRef = { kind: 'array', items: inner.type }
    if (items.nulls > 0 && items.nulls < items.count) type.itemsNullable = true
    return { type }
  }
  return { type: scalarType(stats, path, context) }
}

function singularName(name: string): string {
  const pascal = toPascalCase(name)
  const singular = singularize(pascal)
  return singular === pascal ? `${pascal}Item` : singular
}

function buildModel(object: ObjectStats, name: string, path: string, context: Context): string {
  const modelName = uniqueName(toPascalCase(name) || 'Model', context.usedNames)
  const model: ModelDef = { name: modelName, kind: 'object', fields: [] }
  // Added before the fields so nested models come after their parent, in reading order
  context.models.push(model)
  for (const [key, { present, stats }] of object.keys) {
    const { type } = resolve(stats, key, path ? `${path}.${key}` : key, context)
    const field: FieldDef = {
      name: key,
      type,
      nullable: stats.nulls > 0,
      optional: present < object.count,
    }
    model.fields.push(field)
  }
  if (model.fields.length === 0) context.warnings.push({ code: 'emptyModel', params: { model: modelName } })
  return modelName
}

export interface InferResult {
  schema: ModelSchema
  warnings: ParseIssue[]
}

/** Models described by an example document. Returns null when the document has no object at all
 * (a bare number, an array of strings): there is nothing to map. */
export function inferSchema(value: JsonValue, rootName: string, format: string): InferResult | null {
  const stats = emptyStats()
  collect(stats, value)
  // An array at the root is a list of the root model (`[{...}, {...}]`)
  let root = stats
  while (!root.object && root.array) root = root.array
  if (!root.object) return null
  const context: Context = { models: [], usedNames: new Set(), warnings: [] }
  // `users: [...]` holds users: the model of a list is named in singular
  const name = buildModel(root.object, root === stats ? rootName : singularize(toPascalCase(rootName)), '', context)
  return { schema: { ...emptySchema({ format }), models: context.models, root: name }, warnings: context.warnings }
}

/** Plain JavaScript value (from the YAML parser) as a JsonValue. */
export function fromPlainValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return { kind: 'null' }
  if (typeof value === 'string') return { kind: 'string', value }
  if (typeof value === 'number') return { kind: 'number', text: String(value), integer: Number.isInteger(value) }
  if (typeof value === 'bigint') return { kind: 'number', text: String(value), integer: true }
  if (typeof value === 'boolean') return { kind: 'boolean', value }
  if (value instanceof Date) return { kind: 'string', value: value.toISOString() }
  if (Array.isArray(value)) return { kind: 'array', items: value.map(fromPlainValue) }
  if (value instanceof Map)
    return { kind: 'object', entries: [...value.entries()].map(([key, item]) => [String(key), fromPlainValue(item)]) }
  if (typeof value === 'object') return { kind: 'object', entries: Object.entries(value).map(([key, item]) => [key, fromPlainValue(item)]) }
  return { kind: 'string', value: String(value) }
}
