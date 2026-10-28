import type { EnumDef, FieldDef, Literal, ModelDef, TypeRef } from '../model/schema.ts'
import type { BinaryOperator, Expr, FunctionName } from '../transform/expression.ts'
import type { ArithmeticOperator } from '../mapping/types.ts'
import type { Assignment, MapperPlan, PathStep, Value, ValueNode } from './plan.ts'
import type { GenerationNote } from './types.ts'

/** Writes plan values as expressions. A language describes its syntax with a `Syntax`; the emitter
 * decides where null checks are needed and which conversions apply, the same for every language. */

export interface NullSafeContext {
  /** Type of the value being guarded */
  type: TypeRef
  /** Type of the result of `build` */
  resultType: TypeRef
  /** The result of `build` may itself be null (a nested optional field) */
  resultNullable: boolean
  /** A fresh variable name, for languages that bind the guarded value (`x?.let { v -> … }`) */
  variable: string
}

export interface ExpressionSyntax {
  binary(operator: BinaryOperator, left: string, right: string): string
  not(operand: string): string
  conditional(condition: string, then: string, otherwise: string): string
  call(name: FunctionName, args: string[]): string
}

export interface Syntax {
  /** Reads a field of a value that is not null */
  access(base: string, step: PathStep, name: string): string
  /** Reads a field of a value that may be null, giving null; when absent, `nullSafe` is used */
  safeAccess?(base: string, step: PathStep, name: string): string
  literal(value: Literal, type: TypeRef): string
  convert(expr: string, from: TypeRef, to: TypeRef): string
  concat(parts: string[], separator: string): string
  split(expr: string, separator: string, part: number | 'last' | 'rest'): string
  boolean(expr: string, trueValues: string[], from: TypeRef): string
  enumMap(expr: string, node: Extract<ValueNode, { k: 'enumMap' }>, from: TypeRef): string
  epoch(expr: string, unit: 'seconds' | 'milliseconds', toDate: boolean, from: TypeRef, to: TypeRef): string
  arithmetic(expr: string, operator: ArithmeticOperator, operand: number, type: TypeRef): string
  mapperCall(mapper: MapperPlan, expr: string): string
  list(expr: string, item: string, element: string, isMap: boolean, elementIsItem: boolean): string
  coalesce(expr: string, fallback: string, type: TypeRef): string
  /** `build(v)` when `expr` is not null, null otherwise */
  nullSafe(expr: string, build: (value: string) => string, context: NullSafeContext): string
  /** Asserts that a value is not null, for a target field that cannot hold null */
  unwrap(expr: string, type: TypeRef): string
  /** A placeholder for a required field with no value in the mapping */
  placeholder(type: TypeRef, field: FieldDef): string
  expression: ExpressionSyntax
  /** Wraps a value assigned to a field that may hold null, when the language needs it (Rust `Some`) */
  wrapOptional?(expr: string, type: TypeRef): string
}

export interface Roots {
  source: string
  item: string
  /** Counter for fresh variable names */
  depth: number
  /** Lists entered so far: nested lists name their elements item, item2, item3… */
  lists: number
}

const PRECEDENCE: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
}

export class Emitter {
  readonly syntax: Syntax
  /** Name of a field in code, for each side */
  readonly fieldName: (field: FieldDef, owner: ModelDef, side: 'source' | 'target') => string
  readonly notes: GenerationNote[] = []

  constructor(syntax: Syntax, fieldName: (field: FieldDef, owner: ModelDef, side: 'source' | 'target') => string) {
    this.syntax = syntax
    this.fieldName = fieldName
  }

  /** The value of an assignment, with a placeholder or an assertion when the mapping leaves it incomplete. */
  assignment(assignment: Assignment, roots: Roots): string | null {
    if (assignment.missing) {
      this.notes.push({ code: 'missingValue', params: { field: assignment.field.name } })
      return this.syntax.placeholder(assignment.field.type, assignment.field)
    }
    if (!assignment.value) return null
    let code = this.value(assignment.value, roots)
    if (assignment.unsafeNull) {
      this.notes.push({ code: 'unsafeNull', params: { field: assignment.field.name } })
      code = this.syntax.unwrap(code, assignment.field.type)
    } else if ((assignment.field.nullable || assignment.field.optional) && this.syntax.wrapOptional && !assignment.value.nullable) {
      code = this.syntax.wrapOptional(code, assignment.field.type)
    }
    return code
  }

  private fresh(roots: Roots): string {
    roots.depth++
    return roots.depth === 1 ? 'value' : `value${roots.depth}`
  }

  /** Applies `build` to the value of `input`, guarding it when it may be null. */
  private guarded(input: Value, roots: Roots, resultType: TypeRef, build: (value: string) => string, resultNullable = false): string {
    const expr = this.value(input, roots)
    if (!input.nullable) return build(expr)
    return this.syntax.nullSafe(expr, build, { type: input.type, resultType, resultNullable, variable: this.fresh(roots) })
  }

  value(value: Value, roots: Roots): string {
    const syntax = this.syntax
    switch (value.k) {
      case 'path': {
        let code = value.root === 'source' ? roots.source : roots.item
        let nullable = false
        value.steps.forEach((step) => {
          const name = this.fieldName(step.field, step.owner, 'source')
          if (nullable) {
            if (syntax.safeAccess) code = syntax.safeAccess(code, step, name)
            else {
              const base = code
              code = syntax.nullSafe(base, (inner) => syntax.access(inner, step, name), {
                type: { kind: 'model', name: step.owner.name },
                resultType: step.field.type,
                resultNullable: step.nullable,
                variable: this.fresh(roots),
              })
            }
          } else code = syntax.access(code, step, name)
          nullable = nullable || step.nullable
        })
        return code
      }
      case 'self':
        return value.root === 'source' ? roots.source : roots.item
      case 'literal':
        return syntax.literal(value.value, value.type)
      case 'convert':
        return this.guarded(value.value, roots, value.type, (inner) => syntax.convert(inner, value.value.type, value.type))
      case 'concat':
        return syntax.concat(
          value.parts.map((part) => this.value(part, roots)),
          value.separator,
        )
      case 'split':
        return this.guarded(value.value, roots, value.type, (inner) => syntax.split(inner, value.separator, value.part))
      case 'boolean':
        return this.guarded(value.value, roots, value.type, (inner) => syntax.boolean(inner, value.trueValues, value.value.type))
      case 'enumMap':
        if (value.pairs.length < (value.source?.values.length ?? 0) && value.fallback === undefined)
          this.notes.push({ code: 'enumFallbackThrows', params: { enum: value.target.name } })
        return this.guarded(value.value, roots, value.type, (inner) => syntax.enumMap(inner, value, value.value.type))
      case 'epoch':
        return this.guarded(value.value, roots, value.type, (inner) =>
          syntax.epoch(inner, value.unit, value.toDate, value.value.type, value.type),
        )
      case 'arithmetic':
        return this.guarded(value.value, roots, value.type, (inner) => syntax.arithmetic(inner, value.operator, value.operand, value.type))
      case 'mapper':
        return this.guarded(value.value, roots, value.type, (inner) => syntax.mapperCall(value.mapper, inner))
      case 'list': {
        const item = roots.lists === 0 ? 'item' : `item${roots.lists + 1}`
        const elementRoots: Roots = { source: roots.source, item, depth: roots.depth, lists: roots.lists + 1 }
        const element = this.value(value.element, elementRoots)
        const elementIsItem = value.element.k === 'self'
        return this.guarded(value.value, roots, value.type, (inner) => syntax.list(inner, item, element, value.isMap, elementIsItem))
      }
      case 'coalesce':
        return syntax.coalesce(this.value(value.value, roots), this.value(value.fallback, roots), value.type)
      case 'expr':
        return this.expression(value.expr, value.fields, roots, 0)
    }
  }

  private expression(expr: Expr, fields: Map<string, Value>, roots: Roots, parent: number): string {
    const syntax = this.syntax.expression
    switch (expr.kind) {
      case 'literal':
        return this.syntax.literal(
          expr.value,
          typeof expr.value === 'number'
            ? { kind: 'primitive', name: Number.isInteger(expr.value) ? 'integer' : 'float' }
            : { kind: 'primitive', name: typeof expr.value === 'boolean' ? 'boolean' : 'string' },
        )
      case 'field': {
        const value = fields.get(expr.path.join('.'))
        return value ? this.value(value, roots) : 'null'
      }
      case 'unary': {
        const operand = this.expression(expr.operand, fields, roots, 8)
        return expr.operator === '!' ? syntax.not(operand) : `-${operand}`
      }
      case 'binary': {
        const precedence = PRECEDENCE[expr.operator]
        const left = this.expression(expr.left, fields, roots, precedence)
        const right = this.expression(expr.right, fields, roots, precedence + 1)
        const code = syntax.binary(expr.operator, left, right)
        return precedence < parent ? `(${code})` : code
      }
      case 'conditional': {
        const code = syntax.conditional(
          this.expression(expr.condition, fields, roots, 1),
          this.expression(expr.then, fields, roots, 1),
          this.expression(expr.otherwise, fields, roots, 1),
        )
        return parent > 0 ? `(${code})` : code
      }
      case 'call':
        return syntax.call(
          expr.name,
          expr.args.map((arg) => this.expression(arg, fields, roots, 0)),
        )
    }
  }
}

/** Enum value names as written in code: the name, unless only the wire value is known. */
export function enumValueName(enumDef: EnumDef, name: string): string {
  return enumDef.values.find((value) => value.name === name)?.name ?? name
}

/** Escapes text for a double-quoted string literal (JSON rules, valid in most C-family languages). */
export function quote(text: string): string {
  return JSON.stringify(text)
}

/** Indents every line of a block. */
export function indent(code: string, spaces = 2): string {
  const pad = ' '.repeat(spaces)
  return code
    .split('\n')
    .map((line) => (line === '' ? line : pad + line))
    .join('\n')
}
