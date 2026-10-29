import { toCamelCase } from '../../model/naming.ts'
import { findEnum, type EnumDef, type FieldDef, type Literal, type TypeRef } from '../../model/schema.ts'
import { Emitter, indent, quote, type Syntax } from '../emitter.ts'
import { fieldName, isValidIdentifier, typeName, type NamingRules } from '../naming.ts'
import type { MapperPlan, Plan, Value } from '../plan.ts'
import type { CodeGenerator, GeneratedCode, GenerateSettings } from '../types.ts'

const RESERVED = new Set([
  'associatedtype',
  'class',
  'deinit',
  'enum',
  'extension',
  'fileprivate',
  'func',
  'import',
  'init',
  'inout',
  'internal',
  'let',
  'open',
  'operator',
  'private',
  'protocol',
  'public',
  'rethrows',
  'static',
  'struct',
  'subscript',
  'typealias',
  'var',
  'break',
  'case',
  'continue',
  'default',
  'defer',
  'do',
  'else',
  'fallthrough',
  'for',
  'guard',
  'if',
  'in',
  'repeat',
  'return',
  'switch',
  'where',
  'while',
  'as',
  'catch',
  'false',
  'is',
  'nil',
  'self',
  'super',
  'throw',
  'throws',
  'true',
  'try',
])
const NAMING: NamingRules = { language: 'swift', convention: 'camelCase', reserved: RESERVED, escape: (name) => `\`${name}\`` }

const isPrimitive = (type: TypeRef, ...names: string[]) => type.kind === 'primitive' && names.includes(type.name)
const isNumber = (type: TypeRef) => isPrimitive(type, 'integer', 'float', 'decimal')

function operand(code: string): string {
  return /^[\w.()"!?]+$/.test(code) && !code.includes(' ') ? code : `(${code})`
}

/** Swift string interpolation: `"\(first) \(last)"`. */
function interpolate(parts: string[], separator: string): string {
  return `"${parts.map((part) => `\\(${part})`).join(separator.replace(/[\\"]/g, (char) => `\\${char}`))}"`
}

/** The Swift name of an integer type: Int unless a size is known. */
function intType(type: TypeRef): string {
  return type.kind === 'primitive' && type.bits && type.bits !== 64 ? `Int${type.bits}` : 'Int'
}

class SwiftWriter {
  readonly plan: Plan
  readonly settings: GenerateSettings
  readonly emitter: Emitter
  readonly helpers = new Map<string, { key: string; code: string }>()

  constructor(plan: Plan, settings: GenerateSettings) {
    this.plan = plan
    this.settings = settings
    this.emitter = new Emitter(this.syntax(), (field, _owner, side) => this.name(field, side))
  }

  name(field: FieldDef, side: 'source' | 'target'): string {
    return fieldName(field, side === 'source' ? this.plan.source : this.plan.target, NAMING, this.settings.naming)
  }

  /** A case written as `.name`: Swift infers the enum from the context. */
  enumCase(_enumDef: EnumDef, name: string, side: 'source' | 'target'): string {
    const schema = side === 'source' ? this.plan.source : this.plan.target
    const member = schema.origin?.language === 'swift' && isValidIdentifier(name) ? name : toCamelCase(name) || 'value'
    return `.${RESERVED.has(member) ? `\`${member}\`` : member}`
  }

  functionName(mapper: MapperPlan): string {
    return `to${typeName(mapper.target.name)}`
  }

  literal(value: Literal, type: TypeRef): string {
    if (value === null) return 'nil'
    if (type.kind === 'enum' && typeof value === 'string') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef) return this.enumCase(enumDef, value, 'target')
    }
    if (typeof value === 'number') return isPrimitive(type, 'float') && Number.isInteger(value) ? `${value}.0` : String(value)
    if (typeof value === 'boolean') return String(value)
    if (isPrimitive(type, 'datetime', 'date')) return `ISO8601DateFormatter().date(from: ${quote(value)})!`
    return quote(value)
  }

  convert(expr: string, from: TypeRef, to: TypeRef): string {
    if (isNumber(from) && isNumber(to)) {
      if (isPrimitive(to, 'decimal')) return isPrimitive(from, 'decimal') ? expr : `Decimal(${expr})`
      if (isPrimitive(to, 'float'))
        return isPrimitive(from, 'decimal')
          ? `NSDecimalNumber(decimal: ${expr}).doubleValue`
          : isPrimitive(from, 'float')
            ? expr
            : `Double(${expr})`
      if (isPrimitive(from, 'decimal')) return `NSDecimalNumber(decimal: ${expr}).intValue`
      return intType(from) === intType(to) && !isPrimitive(from, 'float') ? expr : `${intType(to)}(${expr})`
    }
    if (isPrimitive(to, 'string')) {
      if (isPrimitive(from, 'string')) return expr
      if (from.kind === 'enum') return `${operand(expr)}.rawValue`
      if (isPrimitive(from, 'uuid')) return `${operand(expr)}.uuidString`
      if (isPrimitive(from, 'datetime', 'date')) return `ISO8601DateFormatter().string(from: ${expr})`
      return `String(describing: ${expr})`
    }
    if (isPrimitive(from, 'string')) {
      // Text that does not parse stops the program: the validation already warned about it
      if (isPrimitive(to, 'integer')) return `${intType(to)}(${expr})!`
      if (isPrimitive(to, 'float')) return `Double(${expr})!`
      if (isPrimitive(to, 'decimal')) return `Decimal(string: ${expr})!`
      if (isPrimitive(to, 'datetime', 'date')) return `ISO8601DateFormatter().date(from: ${expr})!`
      if (isPrimitive(to, 'uuid')) return `UUID(uuidString: ${expr})!`
      if (to.kind === 'enum') return `${typeName(to.name)}(rawValue: ${expr})!`
    }
    if (isPrimitive(from, 'boolean') && isPrimitive(to, 'integer')) return `${expr} ? 1 : 0`
    return expr
  }

  private enumHelper(node: Extract<Value, { k: 'enumMap' }>): string {
    const source = node.source
    const target = typeName(node.target.name)
    const base = `to${target}`
    const key = JSON.stringify([node.pairs, node.fallback, source?.name])
    let name = base
    for (let n = 2; this.helpers.has(name) && this.helpers.get(name)!.key !== key; n++) name = `${base}${n}`
    if (!this.helpers.has(name)) {
      const cases = node.pairs.map(
        (pair) =>
          `case ${source ? this.enumCase(source, pair.from, 'source') : quote(pair.from)}: return ${this.enumCase(node.target, pair.to, 'target')}`,
      )
      const complete = source !== undefined && node.pairs.length >= source.values.length
      if (node.fallback !== undefined) cases.push(`default: return ${this.enumCase(node.target, node.fallback, 'target')}`)
      else if (!complete) cases.push(`default: fatalError("Unexpected ${source?.name ?? 'value'}: \\(value)")`)
      const code = `private func ${name}(_ value: ${source ? typeName(source.name) : 'String'}) -> ${target} {\n    switch value {\n${indent(cases.join('\n'), 4)}\n    }\n}`
      this.helpers.set(name, { key, code })
    }
    return name
  }

  syntax(): Syntax {
    return {
      access: (base, _step, name) => (base === 'self' ? name : `${base}.${name}`),
      safeAccess: (base, _step, name) => `${base}?.${name}`,
      literal: (value, type) => this.literal(value, type),
      convert: (expr, from, to) => this.convert(expr, from, to),
      concat: (parts, separator) => interpolate(parts, separator),
      split: (expr, separator, part) => {
        const split = `${operand(expr)}.components(separatedBy: ${quote(separator)})`
        if (part === 0) return `${split}.first ?? ""`
        if (part === 'last') return `${split}.last ?? ""`
        if (part === 'rest') return `${split}.dropFirst().joined(separator: ${quote(separator)})`
        return `(${split}.count > ${part} ? ${split}[${part}] : "")`
      },
      boolean: (expr, trueValues, from) => {
        const enumDef = from.kind === 'enum' ? findEnum(this.plan.source, from.name) : undefined
        if (enumDef) return trueValues.map((value) => `${expr} == ${this.enumCase(enumDef, value, 'source')}`).join(' || ')
        return trueValues.length === 1 ? `${expr} == ${quote(trueValues[0])}` : `[${trueValues.map(quote).join(', ')}].contains(${expr})`
      },
      enumMap: (expr, node) => `${this.enumHelper({ ...node, type: { kind: 'enum', name: node.target.name }, nullable: false })}(${expr})`,
      epoch: (expr, unit, toDate) => {
        if (toDate) return `Date(timeIntervalSince1970: ${unit === 'seconds' ? `TimeInterval(${expr})` : `TimeInterval(${expr}) / 1000`})`
        return unit === 'seconds' ? `Int(${operand(expr)}.timeIntervalSince1970)` : `Int(${operand(expr)}.timeIntervalSince1970 * 1000)`
      },
      arithmetic: (expr, operator, value, type) =>
        `${operand(expr)} ${operator} ${isPrimitive(type, 'float') && Number.isInteger(value) ? `${value}.0` : value}`,
      mapperCall: (mapper, expr) =>
        expr === 'self' ? `${this.functionName(mapper)}()` : `${operand(expr)}.${this.functionName(mapper)}()`,
      list: (expr, item, element, isMap, elementIsItem, container) => {
        const isSet = /Set$/.test(container ?? '')
        if (isMap) return elementIsItem ? expr : `${operand(expr)}.mapValues { ${item} in ${element} }`
        if (elementIsItem) return isSet ? `Set(${expr})` : `Array(${expr})`
        const call = new RegExp(`^${item}\\.(\\w+)\\(\\)$`).exec(element)
        const mapped = call ? `${operand(expr)}.map { $0.${call[1]}() }` : `${operand(expr)}.map { ${item} in ${element} }`
        return isSet ? `Set(${mapped})` : mapped
      },
      coalesce: (expr, fallback) => `${expr} ?? ${fallback}`,
      nullSafe: (expr, build, context) => {
        const marker = '\u0000'
        const built = build(marker)
        if (built.startsWith(`${marker}.`) && !built.slice(1).includes(marker)) return `${operand(expr)}?${built.slice(1)}`
        return `${operand(expr)}.map { ${context.variable} in ${build(context.variable)} }`
      },
      unwrap: (expr) => `${operand(expr)}!`,
      placeholder: (_type, field) => `fatalError("No value for ${field.name} in the mapping")`,
      expression: {
        // String.count is an Int
        lengthBits: 64,
        binary: (operator, left, right) => `${left} ${operator} ${right}`,
        not: (value) => `!${operand(value)}`,
        conditional: (condition, then, otherwise) => `${condition} ? ${then} : ${otherwise}`,
        call: (name, args) => {
          const [a, b, c] = args
          switch (name) {
            case 'upper':
              return `${operand(a)}.uppercased()`
            case 'lower':
              return `${operand(a)}.lowercased()`
            case 'trim':
              return `${operand(a)}.trimmingCharacters(in: .whitespaces)`
            case 'length':
              return `${operand(a)}.count`
            case 'concat':
              return interpolate(args, '')
            case 'substring':
              return c === undefined ? `String(${operand(a)}.dropFirst(${b}))` : `String(${operand(a)}.dropFirst(${b}).prefix(${c}))`
            case 'replace':
              return `${operand(a)}.replacingOccurrences(of: ${b}, with: ${c})`
            case 'round':
            case 'floor':
            case 'ceil':
            case 'abs':
              return `${name}(${a})`
            case 'min':
            case 'max':
              return `${name}(${a}, ${b})`
            case 'toString':
              return `String(describing: ${a})`
            case 'toNumber':
              return `Double(${a})!`
          }
        },
      },
    }
  }

  extension(mapper: MapperPlan): string {
    const roots = { source: 'self', item: 'item', depth: 0, lists: 0 }
    const target = typeName(mapper.target.name)
    const lines: string[] = []
    for (const assignment of mapper.assignments) {
      let code = this.emitter.assignment(assignment, roots)
      // The memberwise initializer takes every stored property: optional ones get nil
      if (code === null) {
        if (assignment.field.defaultValue !== undefined) continue
        code = 'nil'
      }
      lines.push(`${this.name(assignment.field, 'target')}: ${code},`)
    }
    if (lines.length > 0) lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '')
    const body = lines.length > 0 ? `${target}(\n${indent(lines.join('\n'), 12)}\n        )` : `${target}()`
    return `extension ${typeName(mapper.source.name)} {\n    func ${this.functionName(mapper)}() -> ${target} {\n        ${body}\n    }\n}`
  }
}

function generate(plan: Plan, settings: GenerateSettings): GeneratedCode {
  const writer = new SwiftWriter(plan, settings)
  const extensions = plan.mappers.map((mapper) => writer.extension(mapper))
  const helpers = [...writer.helpers.values()].map((helper) => helper.code)
  const code = `${['import Foundation', ...extensions, ...helpers].join('\n\n')}\n`
  return { files: [{ name: `${typeName(plan.root.source.name)}+Mapping.swift`, code }], notes: writer.emitter.notes }
}

export const swiftGenerator: CodeGenerator = {
  id: 'swift',
  label: 'Swift',
  editorLanguage: 'swift',
  modes: ['extensions'],
  options: [],
  generate,
}
