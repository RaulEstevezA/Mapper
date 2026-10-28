import { compatibility } from '../model/compatibility.ts'
import {
  allFields,
  findEnum,
  findModel,
  needsValue,
  primitive,
  type EnumDef,
  type FieldDef,
  type Literal,
  type ModelDef,
  type ModelSchema,
  type TypeRef,
} from '../model/schema.ts'
import { resolvePath } from '../mapping/paths.ts'
import { findMapping, type ArithmeticOperator, type FieldMapping, type MappingSet } from '../mapping/types.ts'
import { parseExpression, type Expr } from '../transform/expression.ts'

/** The mapping lowered for the generators: every value says its type and whether it may be null, and
 * every implicit step (a conversion, a fallback, a nested mapper) is explicit. Generators only decide
 * syntax (docs/generators.md). */

export interface PathStep {
  field: FieldDef
  /** This step's value may be null or missing */
  nullable: boolean
  /** Model the field belongs to, for accessor styles (getters, records) */
  owner: ModelDef
}

export type Value = ValueNode & { type: TypeRef; nullable: boolean }

export type ValueNode =
  /** Read from the source object (`root: 'source'`) or from the current list element (`'item'`) */
  | { k: 'path'; root: 'source' | 'item'; steps: PathStep[] }
  /** The whole source object or list element */
  | { k: 'self'; root: 'source' | 'item'; model: ModelDef }
  | { k: 'literal'; value: Literal }
  | { k: 'convert'; value: Value }
  | { k: 'concat'; parts: Value[]; separator: string }
  | { k: 'split'; value: Value; separator: string; part: number | 'last' | 'rest' }
  | { k: 'boolean'; value: Value; trueValues: string[] }
  | { k: 'enumMap'; value: Value; target: EnumDef; pairs: { from: string; to: string }[]; fallback?: string; source?: EnumDef }
  | { k: 'epoch'; value: Value; unit: 'seconds' | 'milliseconds'; toDate: boolean }
  | { k: 'arithmetic'; value: Value; operator: ArithmeticOperator; operand: number }
  | { k: 'mapper'; value: Value; mapper: MapperPlan }
  /** `container`: the target's collection type as written (`Set<String>`, `IReadOnlyList<Item>`), when known */
  | { k: 'list'; value: Value; element: Value; isMap: boolean; container?: string }
  | { k: 'coalesce'; value: Value; fallback: Value }
  | { k: 'expr'; expr: Expr; fields: Map<string, Value> }

export interface Assignment {
  field: FieldDef
  /** null: the mapping gives no value */
  value: Value | null
  /** The target needs a value and gets none: the generator writes a placeholder marked TODO */
  missing: boolean
  /** The value may be null but the field cannot hold null: the generator asserts it with a TODO */
  unsafeNull: boolean
}

export interface MapperPlan {
  id: string
  source: ModelDef
  target: ModelDef
  assignments: Assignment[]
}

export interface Plan {
  root: MapperPlan
  /** Root first, then nested mappers in the order they are used */
  mappers: MapperPlan[]
  source: ModelSchema
  target: ModelSchema
  /** The mapping the plan comes from, so a generator can plan it again with adjusted schemas */
  set: MappingSet
  /** Enums of both sides used by the mapping */
  enums: { source: EnumDef[]; target: EnumDef[] }
}

const make = (node: ValueNode, type: TypeRef, nullable: boolean): Value => ({ ...node, type, nullable }) as Value

function literalType(value: Literal, fallback: TypeRef): TypeRef {
  if (typeof value === 'string') return fallback.kind === 'enum' ? fallback : primitive('string')
  if (typeof value === 'number')
    return fallback.kind === 'primitive' && ['integer', 'float', 'decimal'].includes(fallback.name)
      ? fallback
      : primitive(Number.isInteger(value) ? 'integer' : 'float')
  if (typeof value === 'boolean') return primitive('boolean')
  return fallback
}

/** Identical types need no conversion. Numbers of different (or unknown) size still get a conversion
 * node: some languages need a cast (`Math.toIntExact` in Java), others write nothing. */
function sameScalar(a: TypeRef, b: TypeRef): boolean {
  if (JSON.stringify(a) === JSON.stringify(b)) return true
  const numeric = (type: TypeRef) => type.kind === 'primitive' && (type.name === 'integer' || type.name === 'float')
  if (numeric(a) && numeric(b)) return false
  return compatibility(a, b).level === 'same'
}

/** The value converted to the target type when they differ (int → string, enum → string). */
function convertTo(value: Value, type: TypeRef): Value {
  if (sameScalar(value.type, type)) return value
  if (
    value.type.kind === 'primitive' &&
    type.kind === 'primitive' &&
    value.type.name === type.name &&
    type.name !== 'integer' &&
    type.name !== 'float'
  )
    return value
  return make({ k: 'convert', value }, type, value.nullable)
}

class Planner {
  readonly set: MappingSet
  readonly source: ModelSchema
  readonly target: ModelSchema
  readonly mappers = new Map<string, MapperPlan>()
  readonly order: MapperPlan[] = []
  readonly sourceEnums = new Set<string>()
  readonly targetEnums = new Set<string>()

  constructor(set: MappingSet, source: ModelSchema, target: ModelSchema) {
    this.set = set
    this.source = source
    this.target = target
  }

  mapper(id: string): MapperPlan | null {
    const existing = this.mappers.get(id)
    if (existing) return existing
    const mapping = findMapping(this.set, id)
    const sourceModel = mapping && findModel(this.source, mapping.source)
    const targetModel = mapping && findModel(this.target, mapping.target)
    if (!mapping || !sourceModel || !targetModel) return null
    const plan: MapperPlan = { id, source: sourceModel, target: targetModel, assignments: [] }
    // Registered before its assignments: recursive mappings call themselves
    this.mappers.set(id, plan)
    this.order.push(plan)
    for (const targetField of allFields(this.target, targetModel)) {
      const fieldMapping = mapping.fields.find((item) => item.target === targetField.name)
      plan.assignments.push(this.assignment(fieldMapping, targetField, sourceModel))
    }
    return plan
  }

  private path(root: 'source' | 'item', model: ModelDef, path: string[]): Value | null {
    if (path.length === 0) return make({ k: 'self', root, model }, { kind: 'model', name: model.name }, false)
    const resolved = resolvePath(this.source, model.name, path)
    if (!resolved) return null
    const steps: PathStep[] = []
    let owner = model
    for (const field of resolved.steps) {
      steps.push({ field, nullable: field.nullable || field.optional, owner })
      if (field.type.kind === 'model') owner = findModel(this.source, field.type.name) ?? owner
      if (field.type.kind === 'enum') this.sourceEnums.add(field.type.name)
    }
    return make({ k: 'path', root, steps }, resolved.type, resolved.nullable)
  }

  private assignment(fieldMapping: FieldMapping | undefined, targetField: FieldDef, sourceModel: ModelDef): Assignment {
    if (targetField.type.kind === 'enum') this.targetEnums.add(targetField.type.name)
    const required = needsValue(targetField)
    let value: Value | null = null
    if (fieldMapping && fieldMapping.status === 'active') value = this.value(fieldMapping, targetField, sourceModel)
    if (value && fieldMapping?.fallback !== undefined && fieldMapping.fallback !== null && value.nullable) {
      const fallback = make({ k: 'literal', value: fieldMapping.fallback }, literalType(fieldMapping.fallback, targetField.type), false)
      value = make({ k: 'coalesce', value, fallback }, targetField.type, false)
    }
    if (!value && fieldMapping?.fallback !== undefined && fieldMapping.fallback !== null) {
      // No source, but a default value: the default is the value
      value = make({ k: 'literal', value: fieldMapping.fallback }, literalType(fieldMapping.fallback, targetField.type), false)
    }
    const missing = !value && required
    const unsafeNull = !!value && value.nullable && !targetField.nullable && !targetField.optional
    return { field: targetField, value, missing, unsafeNull }
  }

  private value(
    fieldMapping: FieldMapping,
    targetField: FieldDef,
    sourceModel: ModelDef,
    root: 'source' | 'item' = 'source',
  ): Value | null {
    const transform = fieldMapping.transform
    const targetType = targetField.type
    if (transform.kind === 'constant')
      return make({ k: 'literal', value: transform.value }, literalType(transform.value, targetType), transform.value === null)
    if (transform.kind === 'expression') {
      const parsed = parseExpression(transform.expression)
      if (!parsed.ok) return null
      const fields = new Map<string, Value>()
      for (const path of parsed.fields) {
        const resolved = this.path(root, sourceModel, path)
        if (!resolved) return null
        fields.set(path.join('.'), resolved)
      }
      // An expression handles missing values itself (`a ?? b`): its result is taken as present
      return make({ k: 'expr', expr: parsed.expr, fields }, targetType, false)
    }
    const inputs = fieldMapping.sources.map((path) => this.path(root, sourceModel, path))
    if (inputs.some((input) => input === null) || inputs.length === 0) return null
    const values = inputs as Value[]
    const first = values[0]
    const text = primitive('string')
    switch (transform.kind) {
      case 'direct':
        return convertTo(first, targetType)
      case 'concat': {
        // A missing part is joined as empty text, so the result is never null
        const parts = values.map((part) => {
          const asText = convertTo(part, text)
          return asText.nullable
            ? make({ k: 'coalesce', value: asText, fallback: make({ k: 'literal', value: '' }, text, false) }, text, false)
            : asText
        })
        return make({ k: 'concat', parts, separator: transform.separator }, text, false)
      }
      case 'split':
        return make({ k: 'split', value: first, separator: transform.separator, part: transform.part }, text, first.nullable)
      case 'boolean':
        return make({ k: 'boolean', value: first, trueValues: transform.trueValues }, primitive('boolean'), first.nullable)
      case 'enum': {
        const targetEnum = targetType.kind === 'enum' ? findEnum(this.target, targetType.name) : undefined
        if (!targetEnum) return null
        const sourceEnum = first.type.kind === 'enum' ? findEnum(this.source, first.type.name) : undefined
        if (sourceEnum) this.sourceEnums.add(sourceEnum.name)
        this.targetEnums.add(targetEnum.name)
        const node: ValueNode = {
          k: 'enumMap',
          value: first,
          target: targetEnum,
          pairs: transform.pairs,
          ...(transform.fallback !== undefined ? { fallback: transform.fallback } : {}),
          ...(sourceEnum ? { source: sourceEnum } : {}),
        }
        return make(node, targetType, first.nullable)
      }
      case 'epoch': {
        const toDate = targetType.kind === 'primitive' && (targetType.name === 'datetime' || targetType.name === 'date')
        return make({ k: 'epoch', value: first, unit: transform.unit, toDate }, targetType, first.nullable)
      }
      case 'arithmetic':
        return make(
          { k: 'arithmetic', value: convertTo(first, targetType), operator: transform.operator, operand: transform.operand },
          targetType,
          first.nullable,
        )
      case 'object': {
        const mapper = this.mapper(transform.mapping)
        if (!mapper) return null
        return make({ k: 'mapper', value: first, mapper }, targetType, first.nullable)
      }
      case 'collection': {
        const sourceItems = first.type.kind === 'array' ? first.type.items : first.type.kind === 'map' ? first.type.value : null
        const targetItems = targetType.kind === 'array' ? targetType.items : targetType.kind === 'map' ? targetType.value : null
        if (!sourceItems || !targetItems) return null
        const itemsNullable = first.type.kind === 'array' && first.type.itemsNullable === true
        const item = sourceItems.kind === 'model' ? findModel(this.source, sourceItems.name) : undefined
        let element: Value
        if (transform.mapping) {
          const mapper = this.mapper(transform.mapping)
          if (!mapper || !item) return null
          element = make(
            { k: 'mapper', value: make({ k: 'self', root: 'item', model: item }, sourceItems, itemsNullable), mapper },
            targetItems,
            itemsNullable,
          )
        } else {
          if (targetItems.kind === 'enum') this.targetEnums.add(targetItems.name)
          const itemValue = make(
            { k: 'self', root: 'item', model: item ?? { name: '', kind: 'object', fields: [] } },
            sourceItems,
            itemsNullable,
          )
          element = convertTo(itemValue, targetItems)
        }
        const container = targetField.originalType?.split('<')[0].trim()
        return make(
          { k: 'list', value: first, element, isMap: first.type.kind === 'map', ...(container ? { container } : {}) },
          targetType,
          first.nullable,
        )
      }
    }
  }
}

/** Lowers the mapping (from its root) for the generators. */
export function buildPlan(set: MappingSet, source: ModelSchema, target: ModelSchema): Plan | null {
  const planner = new Planner(set, source, target)
  const root = planner.mapper(set.root)
  if (!root) return null
  const enums = {
    source: [...planner.sourceEnums].map((name) => findEnum(source, name)).filter((item): item is EnumDef => item !== undefined),
    target: [...planner.targetEnums].map((name) => findEnum(target, name)).filter((item): item is EnumDef => item !== undefined),
  }
  return { root, mappers: planner.order, source, target, set, enums }
}

/** Visits every value of a plan, nested ones included. */
export function walkValue(value: Value, visit: (value: Value) => void) {
  visit(value)
  switch (value.k) {
    case 'convert':
    case 'split':
    case 'boolean':
    case 'enumMap':
    case 'epoch':
    case 'arithmetic':
    case 'mapper':
      walkValue(value.value, visit)
      break
    case 'list':
      walkValue(value.value, visit)
      walkValue(value.element, visit)
      break
    case 'coalesce':
      walkValue(value.value, visit)
      walkValue(value.fallback, visit)
      break
    case 'concat':
      value.parts.forEach((part) => walkValue(part, visit))
      break
    case 'expr':
      for (const field of value.fields.values()) walkValue(field, visit)
      break
    case 'path':
    case 'self':
    case 'literal':
      break
  }
}

/** Every value of a plan, for generators that need to know what is used (imports, helpers). */
export function allValues(plan: Plan): Value[] {
  const values: Value[] = []
  for (const mapper of plan.mappers)
    for (const assignment of mapper.assignments) if (assignment.value) walkValue(assignment.value, (value) => values.push(value))
  return values
}

// Formats that describe documents: dates, times and ids in them are text
const DOCUMENT_FORMATS = new Set(['json', 'yaml', 'xml', 'csv', 'jsonschema', 'openapi', 'modelschema'])
const TEXTUAL: ReadonlySet<string> = new Set(['date', 'datetime', 'time', 'duration', 'uuid'])

function textualType(type: TypeRef): TypeRef {
  if (type.kind === 'primitive' && TEXTUAL.has(type.name)) return primitive('string')
  if (type.kind === 'array') return { ...type, items: textualType(type.items) }
  if (type.kind === 'map') return { ...type, value: textualType(type.value) }
  return type
}

/** Whether the schema describes a document read as plain objects (JSON keys and text values). */
export function isDocumentSchema(schema: ModelSchema): boolean {
  return DOCUMENT_FORMATS.has(schema.origin?.format ?? '')
}

/** The schema as a program sees a document read as plain objects: dates and ids are text. */
export function asDocumentValues(schema: ModelSchema): ModelSchema {
  if (!isDocumentSchema(schema)) return schema
  return {
    ...schema,
    models: schema.models.map((model) => ({
      ...model,
      fields: model.fields.map((field) => ({ ...field, type: textualType(field.type) })),
    })),
  }
}

/** The plan for a language that reads and writes documents as plain objects (JavaScript, Python dicts). */
export function planForPlainObjects(plan: Plan, source: boolean, target: boolean): Plan {
  if (!(source && isDocumentSchema(plan.source)) && !(target && isDocumentSchema(plan.target))) return plan
  return (
    buildPlan(plan.set, source ? asDocumentValues(plan.source) : plan.source, target ? asDocumentValues(plan.target) : plan.target) ?? plan
  )
}
