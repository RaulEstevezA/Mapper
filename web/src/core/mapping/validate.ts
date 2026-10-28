import { compatibility } from '../model/compatibility.ts'
import { allFields, findEnum, findModel, needsValue, type FieldDef, type Literal, type ModelSchema, type TypeRef } from '../model/schema.ts'
import { checkExpression, parseExpression, type ExpressionError, type ValueKind } from '../transform/expression.ts'
import { elementType, resolvePath } from './paths.ts'
import { findMapping, pathKey, type FieldMapping, type MappingSet, type ModelMapping } from './types.ts'

/** Checks a mapping before generating code. Errors make the generated code wrong or incomplete;
 * warnings may fail at run time or lose information; information needs no action (docs/mapping-engine.md). */

export type Severity = 'error' | 'warning' | 'info'

export type DiagnosticCode =
  // Errors
  | 'requiredMissing'
  | 'unknownSource'
  | 'incompatibleType'
  | 'needsTransform'
  | 'sourceCount'
  | 'transformType'
  | 'booleanValues'
  | 'invalidExpression'
  | 'unresolvedObject'
  | 'constantType'
  // Warnings
  | 'nullToRequired'
  | 'fallibleConversion'
  | 'lossyConversion'
  | 'enumIncomplete'
  | 'pendingSuggestion'
  | 'conflictPending'
  // Information
  | 'unusedSource'
  | 'optionalUnmapped'
  | 'conversion'
  | 'sharedSource'

export interface Diagnostic {
  severity: Severity
  code: DiagnosticCode
  /** Model mapping it belongs to */
  mapping: string
  /** Target field, when it is about one */
  target?: string
  params?: Record<string, string | number>
  /** For invalid expressions */
  expressionError?: ExpressionError
}

const SEVERITY: Record<DiagnosticCode, Severity> = {
  requiredMissing: 'error',
  unknownSource: 'error',
  incompatibleType: 'error',
  needsTransform: 'error',
  sourceCount: 'error',
  transformType: 'error',
  booleanValues: 'error',
  invalidExpression: 'error',
  unresolvedObject: 'error',
  constantType: 'error',
  nullToRequired: 'warning',
  fallibleConversion: 'warning',
  lossyConversion: 'warning',
  enumIncomplete: 'warning',
  pendingSuggestion: 'warning',
  conflictPending: 'warning',
  unusedSource: 'info',
  optionalUnmapped: 'info',
  conversion: 'info',
  sharedSource: 'info',
}

interface Context {
  set: MappingSet
  source: ModelSchema
  target: ModelSchema
  diagnostics: Diagnostic[]
}

function add(
  context: Context,
  code: DiagnosticCode,
  mapping: string,
  target?: string,
  params?: Diagnostic['params'],
  expressionError?: ExpressionError,
) {
  const diagnostic: Diagnostic = { severity: SEVERITY[code], code, mapping }
  if (target !== undefined) diagnostic.target = target
  if (params) diagnostic.params = params
  if (expressionError) diagnostic.expressionError = expressionError
  context.diagnostics.push(diagnostic)
}

const isText = (type: TypeRef) => type.kind === 'primitive' && (type.name === 'string' || type.name === 'any')
const isNumber = (type: TypeRef) => type.kind === 'primitive' && ['integer', 'float', 'decimal', 'any'].includes(type.name)
const isTemporal = (type: TypeRef) => type.kind === 'primitive' && ['datetime', 'date'].includes(type.name)

/** Kind of a value in the expression language. Dates, ids and objects are opaque ("any"). */
export function valueKind(type: TypeRef): ValueKind {
  if (type.kind === 'enum') return 'string'
  if (type.kind !== 'primitive') return 'any'
  if (type.name === 'string') return 'string'
  if (type.name === 'integer' || type.name === 'float' || type.name === 'decimal') return 'number'
  if (type.name === 'boolean') return 'boolean'
  return 'any'
}

function literalFits(value: Literal, type: TypeRef, target: ModelSchema): boolean {
  if (value === null) return true
  if (type.kind === 'enum')
    return (
      typeof value === 'string' &&
      (findEnum(target, type.name)?.values.some((item) => item.name === value || item.value === value) ?? false)
    )
  if (type.kind !== 'primitive') return false
  switch (type.name) {
    case 'any':
      return true
    case 'boolean':
      return typeof value === 'boolean'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'float':
    case 'decimal':
      return typeof value === 'number'
    default:
      return typeof value === 'string'
  }
}

function checkField(context: Context, mapping: ModelMapping, field: FieldMapping, targetField: FieldDef) {
  const { source, target } = context
  const id = mapping.id
  const name = field.target

  if (field.status === 'ignored' || field.status === 'unmapped' || field.status === 'pending') {
    if (field.status === 'pending') add(context, field.confidence === 'conflict' ? 'conflictPending' : 'pendingSuggestion', id, name)
    if (needsValue(targetField)) {
      if (field.fallback === undefined || field.fallback === null) add(context, 'requiredMissing', id, name)
    } else if (field.status === 'unmapped') add(context, 'optionalUnmapped', id, name)
    return
  }

  const resolved = field.sources.map((path) => ({ path, resolved: resolvePath(source, mapping.source, path) }))
  for (const { path, resolved: value } of resolved) if (!value) add(context, 'unknownSource', id, name, { path: pathKey(path) || '(root)' })
  if (resolved.some((item) => !item.resolved)) return
  const values = resolved.map((item) => item.resolved!)
  const transform = field.transform
  const expected =
    transform.kind === 'constant'
      ? { min: 0, max: 0 }
      : transform.kind === 'concat'
        ? { min: 2, max: Infinity }
        : transform.kind === 'expression'
          ? { min: 0, max: Infinity }
          : { min: 1, max: 1 }
  if (values.length < expected.min || values.length > expected.max) {
    add(context, 'sourceCount', id, name, { transform: transform.kind, count: values.length })
    return
  }
  const first = values[0]
  const nullable = values.some((value) => value.nullable)
  const targetType = targetField.type
  const fallback = field.fallback !== undefined && field.fallback !== null

  switch (transform.kind) {
    case 'direct': {
      const result = compatibility(first.type, targetType)
      const level = result.level === 'collection' ? (result.items?.level ?? 'same') : result.level
      if (result.level === 'incompatible') add(context, 'incompatibleType', id, name)
      else if (level === 'transform') add(context, 'needsTransform', id, name)
      else if (level === 'nested') add(context, 'unresolvedObject', id, name)
      else if (level === 'conversion') {
        const inner = result.level === 'collection' ? result.items! : result
        add(context, inner.fallible ? 'fallibleConversion' : inner.lossy ? 'lossyConversion' : 'conversion', id, name)
      }
      break
    }
    case 'concat':
      if (!isText(targetType)) add(context, 'transformType', id, name, { transform: 'concat' })
      break
    case 'split':
      if (!isText(first.type) || !isText(targetType)) add(context, 'transformType', id, name, { transform: 'split' })
      break
    case 'constant':
      if (!literalFits(transform.value, targetType, target)) add(context, 'constantType', id, name)
      break
    case 'boolean':
      if (!(targetType.kind === 'primitive' && targetType.name === 'boolean') || !(isText(first.type) || first.type.kind === 'enum'))
        add(context, 'transformType', id, name, { transform: 'boolean' })
      else if (transform.trueValues.length === 0) add(context, 'booleanValues', id, name)
      break
    case 'enum': {
      const sourceValues = first.type.kind === 'enum' ? (findEnum(source, first.type.name)?.values.map((value) => value.name) ?? []) : null
      if (targetType.kind !== 'enum' || !(first.type.kind === 'enum' || isText(first.type))) {
        add(context, 'transformType', id, name, { transform: 'enum' })
        break
      }
      const targetValues = new Set(findEnum(target, targetType.name)?.values.map((value) => value.name) ?? [])
      const badPair = transform.pairs.find((pair) => !targetValues.has(pair.to))
      if (badPair) {
        add(context, 'transformType', id, name, { transform: 'enum', value: badPair.to })
        break
      }
      if (sourceValues && transform.fallback === undefined) {
        const missing = sourceValues.filter((value) => !transform.pairs.some((pair) => pair.from === value))
        if (missing.length > 0) add(context, 'enumIncomplete', id, name, { values: missing.join(', '), count: missing.length })
      }
      break
    }
    case 'epoch':
      if (!((isNumber(first.type) && isTemporal(targetType)) || (isTemporal(first.type) && isNumber(targetType))))
        add(context, 'transformType', id, name, { transform: 'epoch' })
      break
    case 'arithmetic':
      if (!isNumber(first.type) || !isNumber(targetType)) add(context, 'transformType', id, name, { transform: 'arithmetic' })
      else if (transform.operator === '/' && transform.operand === 0)
        add(context, 'transformType', id, name, { transform: 'arithmetic', operand: 0 })
      break
    case 'object': {
      const nested = findMapping(context.set, transform.mapping)
      const expectedTarget = targetType.kind === 'model' ? targetType.name : null
      if (!nested || first.type.kind !== 'model' || nested.source !== first.type.name || nested.target !== expectedTarget)
        add(context, 'unresolvedObject', id, name)
      break
    }
    case 'collection': {
      if (first.type.kind !== targetType.kind || (first.type.kind !== 'array' && first.type.kind !== 'map')) {
        add(context, 'incompatibleType', id, name)
        break
      }
      const from = elementType(first.type)
      const to = elementType(targetType)
      if (from.kind === 'model' || to.kind === 'model') {
        const nested = transform.mapping ? findMapping(context.set, transform.mapping) : undefined
        if (!nested || from.kind !== 'model' || to.kind !== 'model' || nested.source !== from.name || nested.target !== to.name)
          add(context, 'unresolvedObject', id, name)
      } else {
        const result = compatibility(from, to)
        if (result.level === 'incompatible' || result.level === 'transform') add(context, 'incompatibleType', id, name)
        else if (result.level === 'conversion')
          add(context, result.fallible ? 'fallibleConversion' : result.lossy ? 'lossyConversion' : 'conversion', id, name)
      }
      break
    }
    case 'expression': {
      const parsed = parseExpression(transform.expression)
      if (!parsed.ok) {
        add(context, 'invalidExpression', id, name, undefined, parsed.error)
        break
      }
      const checked = checkExpression(parsed.expr, (path) => {
        const value = resolvePath(source, mapping.source, path)
        return value ? valueKind(value.type) : null
      })
      if ('error' in checked) {
        add(context, 'invalidExpression', id, name, undefined, checked.error)
        break
      }
      const wanted = valueKind(targetType)
      if (wanted !== 'any' && checked.kind !== 'any' && checked.kind !== 'null' && checked.kind !== wanted)
        add(context, 'transformType', id, name, { transform: 'expression', expected: wanted, found: checked.kind })
      break
    }
  }

  // A value that may be null going into a field that cannot hold null
  const producesNull = transform.kind !== 'constant' && transform.kind !== 'concat' && transform.kind !== 'boolean' && nullable
  if (producesNull && !targetField.nullable && !fallback) add(context, 'nullToRequired', id, name)
}

/** Diagnostics of the root mapping and of every mapping it uses, errors first. */
export function validateMapping(set: MappingSet, source: ModelSchema, target: ModelSchema): Diagnostic[] {
  const context: Context = { set, source, target, diagnostics: [] }
  const visited = new Set<string>()
  const queue = [set.root]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const mapping = findMapping(set, id)
    if (!mapping) continue
    const targetModel = findModel(target, mapping.target)
    const sourceModel = findModel(source, mapping.source)
    if (!targetModel || !sourceModel) continue
    const targetFields = allFields(target, targetModel)
    for (const targetField of targetFields) {
      const field = mapping.fields.find((item) => item.target === targetField.name)
      if (!field) {
        if (needsValue(targetField)) add(context, 'requiredMissing', id, targetField.name)
        continue
      }
      checkField(context, mapping, field, targetField)
      if (
        field.status === 'active' &&
        (field.transform.kind === 'object' || field.transform.kind === 'collection') &&
        field.transform.mapping
      )
        queue.push(field.transform.mapping)
    }

    // Source fields nobody uses, and the same source used by several targets
    const uses = new Map<string, string[]>()
    for (const field of mapping.fields) {
      if (field.status !== 'active') continue
      const paths =
        field.transform.kind === 'expression'
          ? (() => {
              const parsed = parseExpression(field.transform.expression)
              return parsed.ok ? parsed.fields : []
            })()
          : field.sources
      for (const path of paths) {
        const key = path[0] ?? ''
        uses.set(key, [...(uses.get(key) ?? []), field.target])
      }
    }
    const usesRoot = uses.has('')
    for (const sourceField of allFields(source, sourceModel)) {
      const targets = uses.get(sourceField.name)
      if (!targets && !usesRoot && !mapping.ignoredSources.includes(sourceField.name))
        add(context, 'unusedSource', id, undefined, { field: sourceField.name })
    }
    for (const field of mapping.fields) {
      if (field.status !== 'active' || field.transform.kind === 'split' || field.sources.length !== 1 || field.sources[0].length === 0)
        continue
      const key = pathKey(field.sources[0])
      const sharing = mapping.fields.filter(
        (other) =>
          other !== field &&
          other.status === 'active' &&
          other.transform.kind !== 'split' &&
          other.sources.some((path) => pathKey(path) === key),
      )
      if (sharing.length > 0 && sharing.every((other) => other.target > field.target))
        add(context, 'sharedSource', id, field.target, { path: key, count: sharing.length + 1 })
    }
  }
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
  return context.diagnostics.sort((a, b) => order[a.severity] - order[b.severity])
}

export function summarizeDiagnostics(diagnostics: Diagnostic[]): Record<Severity, number> {
  const summary: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const diagnostic of diagnostics) summary[diagnostic.severity]++
  return summary
}
