import { sameType, type EnumDef, type FieldDef, type Literal, type ModelDef, type TypeRef } from '../model/schema.ts'
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
  /** `type`: the number type of both branches, when they are numbers */
  conditional(condition: string, then: string, otherwise: string, type: TypeRef | null): string
  /** `types`: the number type of each argument, null when it is not a number */
  call(name: FunctionName, args: string[], types: (TypeRef | null)[]): string
  /** Bits of the integer of text lengths and positions, `length()` and `substring()` (default 32) */
  lengthBits?: 32 | 64
  /** Every number has the same type (JavaScript): an expression needs no number conversions */
  oneNumberType?: boolean
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
  /** `container`: the target collection type as written, when known (`Set`, `List`, `IReadOnlyList`) */
  list(expr: string, item: string, element: string, isMap: boolean, elementIsItem: boolean, container?: string): string
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
  /** Written before variable names (`$` in PHP) */
  variablePrefix?: string
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

const INTEGER: TypeRef = { kind: 'primitive', name: 'integer' }
const FLOAT: TypeRef = { kind: 'primitive', name: 'float' }
const isInteger = (type: TypeRef) => type.kind === 'primitive' && type.name === 'integer'
const isNumberType = (type: TypeRef) => type.kind === 'primitive' && ['integer', 'float', 'decimal'].includes(type.name)
const isNumberLiteral = (expr: Expr) => expr.kind === 'literal' && typeof expr.value === 'number'

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
    return `${this.syntax.variablePrefix ?? ''}${roots.depth === 1 ? 'value' : `value${roots.depth}`}`
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
        const item = `${syntax.variablePrefix ?? ''}${roots.lists === 0 ? 'item' : `item${roots.lists + 1}`}`
        const elementRoots: Roots = { source: roots.source, item, depth: roots.depth, lists: roots.lists + 1 }
        const element = this.value(value.element, elementRoots)
        const elementIsItem = value.element.k === 'self'
        return this.guarded(value.value, roots, value.type, (inner) =>
          syntax.list(inner, item, element, value.isMap, elementIsItem, value.container),
        )
      }
      case 'coalesce':
        return syntax.coalesce(this.value(value.value, roots), this.value(value.fallback, roots), value.type)
      case 'expr':
        return this.typed(value.expr, value.fields, roots, 0, isNumberType(value.type) ? value.type : null)
    }
  }

  /** Number type of an expression's value, null when it is not a number. Integers stay integers; `/`
   * divides as real numbers, so it gives a float, like any operation with a float or a decimal. */
  private numberType(expr: Expr, fields: Map<string, Value>): TypeRef | null {
    switch (expr.kind) {
      case 'literal':
        return typeof expr.value === 'number' ? (Number.isInteger(expr.value) ? INTEGER : FLOAT) : null
      case 'field': {
        const type = fields.get(expr.path.join('.'))?.type
        return type && isNumberType(type) ? type : null
      }
      case 'unary':
        return expr.operator === '-' ? this.numberType(expr.operand, fields) : null
      case 'binary':
        if (expr.operator === '/') return FLOAT
        if (expr.operator === '??') return this.commonType(expr.left, expr.right, fields, true)
        return ['+', '-', '*', '%'].includes(expr.operator) ? this.commonType(expr.left, expr.right, fields, false) : null
      case 'conditional':
        return this.commonType(expr.then, expr.otherwise, fields, true)
      case 'call': {
        switch (expr.name) {
          case 'round':
          case 'floor':
          case 'ceil':
          case 'abs': {
            const type = this.numberType(expr.args[0], fields)
            return type && isInteger(type) ? type : FLOAT
          }
          case 'min':
          case 'max':
            return this.commonType(expr.args[0], expr.args[1], fields, false)
          case 'length':
            return this.textInteger()
          case 'toNumber':
            return FLOAT
          default:
            return null
        }
      }
    }
  }

  /** The integer type of text lengths and positions (`length`, `substring`) */
  private textInteger(): TypeRef {
    return { kind: 'primitive', name: 'integer', bits: this.syntax.expression.lengthBits ?? 32 }
  }

  /** The type two numbers are brought to before they meet: a number literal takes the other side's type
   * when it fits, integers of different sizes meet as 64-bit integers and anything else as a float. A
   * decimal only stays a decimal where no operator works on it (`keepDecimal`: conditional branches, `??`). */
  private commonType(a: Expr, b: Expr, fields: Map<string, Value>, keepDecimal: boolean): TypeRef | null {
    const left = this.numberType(a, fields)
    const right = this.numberType(b, fields)
    if (!left || !right) return null
    const usable = (type: TypeRef) => keepDecimal || type.kind !== 'primitive' || type.name !== 'decimal'
    const fits = (literal: Expr, type: TypeRef) =>
      isNumberLiteral(literal) && usable(type) && (!isInteger(type) || Number.isInteger((literal as { value: number }).value))
    if (fits(b, left)) return left
    if (fits(a, right)) return right
    if (sameNumber(left, right) && usable(left)) return left
    return isInteger(left) && isInteger(right) ? INTEGER : FLOAT
  }

  /** An expression whose value is brought to the number type `want`, when given: a number literal is
   * written in that type, anything else is converted. Conditionals pass `want` on to their branches. */
  private typed(expr: Expr, fields: Map<string, Value>, roots: Roots, parent: number, want: TypeRef | null): string {
    if (!want || this.syntax.expression.oneNumberType) return this.expression(expr, fields, roots, parent, null)
    if (expr.kind === 'conditional' || expr.kind === 'unary' || (expr.kind === 'binary' && expr.operator === '??'))
      return this.expression(expr, fields, roots, parent, want)
    const type = this.numberType(expr, fields)
    if (!type || sameNumber(type, want)) return this.expression(expr, fields, roots, parent, null)
    if (expr.kind === 'literal' && typeof expr.value === 'number') return this.syntax.literal(expr.value, want)
    return this.syntax.convert(this.expression(expr, fields, roots, 0, null), type, want)
  }

  private expression(expr: Expr, fields: Map<string, Value>, roots: Roots, parent: number, want: TypeRef | null): string {
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
        if (expr.operator === '!') return syntax.not(this.expression(expr.operand, fields, roots, 8, null))
        return `-${this.typed(expr.operand, fields, roots, 8, want)}`
      }
      case 'binary': {
        const precedence = PRECEDENCE[expr.operator]
        // Both sides in the same number type: `/` always divides as real numbers
        const sides =
          expr.operator === '/'
            ? FLOAT
            : expr.operator === '??'
              ? (want ?? this.commonType(expr.left, expr.right, fields, true))
              : expr.operator === '&&' || expr.operator === '||'
                ? null
                : this.commonType(expr.left, expr.right, fields, false)
        const left = this.typed(expr.left, fields, roots, precedence, sides)
        const right = this.typed(expr.right, fields, roots, precedence + 1, sides)
        const code = syntax.binary(expr.operator, left, right)
        return precedence < parent ? `(${code})` : code
      }
      case 'conditional': {
        const type = want ?? this.commonType(expr.then, expr.otherwise, fields, true)
        const code = syntax.conditional(
          this.expression(expr.condition, fields, roots, 1, null),
          this.typed(expr.then, fields, roots, 1, type),
          this.typed(expr.otherwise, fields, roots, 1, type),
          syntax.oneNumberType ? null : type,
        )
        return parent > 0 ? `(${code})` : code
      }
      case 'call': {
        const [first, second] = expr.args
        let wants: (TypeRef | null)[] = expr.args.map(() => null)
        switch (expr.name) {
          case 'round':
          case 'floor':
          case 'ceil':
          case 'abs': {
            const type = this.numberType(first, fields)
            // An integer is already whole
            if (type && isInteger(type)) {
              if (expr.name !== 'abs') return this.expression(first, fields, roots, parent, null)
            } else wants = [FLOAT]
            break
          }
          case 'min':
          case 'max': {
            const type = this.commonType(first, second, fields, false)
            wants = [type, type]
            break
          }
          case 'substring':
            wants = [null, this.textInteger(), this.textInteger()]
            break
        }
        const types = expr.args.map((arg, index) => (syntax.oneNumberType ? null : (wants[index] ?? this.numberType(arg, fields))))
        return syntax.call(
          expr.name,
          expr.args.map((arg, index) => this.typed(arg, fields, roots, 0, wants[index])),
          types,
        )
      }
    }
  }
}

/** Same number type: integers without a size are 64-bit. */
function sameNumber(a: TypeRef, b: TypeRef): boolean {
  if (a.kind !== 'primitive' || b.kind !== 'primitive' || a.name !== b.name) return sameType(a, b)
  return a.name === 'integer' || a.name === 'float' ? (a.bits ?? 64) === (b.bits ?? 64) : true
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
