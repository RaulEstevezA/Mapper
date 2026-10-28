import { toScreamingSnakeCase } from '../../model/naming.ts'
import { findEnum, type EnumDef, type FieldDef, type Literal, type ModelSchema, type TypeRef } from '../../model/schema.ts'
import { Emitter, indent, quote, type Syntax } from '../emitter.ts'
import { fieldName, isValidIdentifier, typeName, type NamingRules } from '../naming.ts'
import type { MapperPlan, Plan, Value } from '../plan.ts'
import { optionValue, type CodeGenerator, type GeneratedCode, type GenerateSettings } from '../types.ts'

const RESERVED = new Set([
  'as',
  'break',
  'class',
  'continue',
  'do',
  'else',
  'false',
  'for',
  'fun',
  'if',
  'in',
  'interface',
  'is',
  'null',
  'object',
  'package',
  'return',
  'super',
  'this',
  'throw',
  'true',
  'try',
  'typealias',
  'typeof',
  'val',
  'var',
  'when',
  'while',
])
const NAMING: NamingRules = { language: 'kotlin', convention: 'camelCase', reserved: RESERVED, escape: (name) => `\`${name}\`` }

const isNumber = (type: TypeRef) => type.kind === 'primitive' && ['integer', 'float', 'decimal'].includes(type.name)
const isPrimitive = (type: TypeRef, ...names: string[]) => type.kind === 'primitive' && names.includes(type.name)

function operand(code: string): string {
  return /^[\w.()"?!]+$/.test(code) && !code.includes(' ') ? code : `(${code})`
}

/** Kotlin string template: `$` and `"` escaped, values in `${…}`. */
function template(parts: string[], separator: string): string {
  const literal = separator.replace(/[\\"$]/g, (char) => `\\${char}`)
  return `"${parts.map((part) => `\${${part}}`).join(literal)}"`
}

function dateTimeClass(schema: ModelSchema): string {
  if (schema.origin?.language === 'kotlin' || schema.origin?.language === 'java') {
    for (const model of schema.models)
      for (const field of model.fields) {
        const declared = field.originalType?.replace(/\?$/, '').replace(/^.*\./, '')
        if (
          isPrimitive(field.type, 'datetime') &&
          declared &&
          ['Instant', 'OffsetDateTime', 'LocalDateTime', 'ZonedDateTime'].includes(declared)
        )
          return declared
      }
  }
  return 'Instant'
}

class KotlinWriter {
  readonly plan: Plan
  readonly settings: GenerateSettings
  readonly emitter: Emitter
  readonly imports = new Set<string>()
  readonly helpers = new Map<string, { key: string; code: string }>()
  readonly sourceDateTime: string
  readonly targetDateTime: string

  constructor(plan: Plan, settings: GenerateSettings) {
    this.plan = plan
    this.settings = settings
    this.sourceDateTime = dateTimeClass(plan.source)
    this.targetDateTime = dateTimeClass(plan.target)
    this.emitter = new Emitter(this.syntax(), (field, _owner, side) => this.name(field, side))
  }

  name(field: FieldDef, side: 'source' | 'target'): string {
    return fieldName(field, side === 'source' ? this.plan.source : this.plan.target, NAMING, this.settings.naming)
  }

  enumMember(enumDef: EnumDef, name: string): string {
    return `${typeName(enumDef.name)}.${isValidIdentifier(name) && !(enumDef.kind === 'literals' && /[a-z]/.test(name)) ? name : toScreamingSnakeCase(name) || 'VALUE'}`
  }

  functionName(mapper: MapperPlan): string {
    return `to${typeName(mapper.target.name)}`
  }

  private use(name: string) {
    this.imports.add(name)
  }

  literal(value: Literal, type: TypeRef): string {
    if (value === null) return 'null'
    if (type.kind === 'enum' && typeof value === 'string') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef) return this.enumMember(enumDef, value)
    }
    if (typeof value === 'number') {
      if (isPrimitive(type, 'decimal')) {
        this.use('java.math.BigDecimal')
        return `BigDecimal(${quote(String(value))})`
      }
      if (isPrimitive(type, 'float')) return Number.isInteger(value) ? `${value}.0` : String(value)
      if (type.kind === 'primitive' && type.name === 'integer' && type.bits !== 32) return `${value}L`
      return String(value)
    }
    if (typeof value === 'boolean') return String(value)
    if (isPrimitive(type, 'datetime')) {
      this.use(`java.time.${this.targetDateTime}`)
      return `${this.targetDateTime}.parse(${quote(value)})`
    }
    return `"${value.replace(/[\\"$]/g, (char) => `\\${char}`)}"`
  }

  convert(expr: string, from: TypeRef, to: TypeRef): string {
    const target = operand(expr)
    if (isNumber(from) && isNumber(to) && from.kind === 'primitive' && to.kind === 'primitive') {
      if (to.name === 'decimal') {
        if (from.name === 'decimal') return expr
        this.use('java.math.BigDecimal')
        return `${target}.toBigDecimal()`
      }
      if (to.name === 'float') return from.name === 'float' && from.bits === to.bits ? expr : `${target}.toDouble()`
      if (from.name !== 'integer') return to.bits === 32 ? `${target}.toInt()` : `${target}.toLong()`
      if (to.bits === 32 && from.bits !== 32) return `${target}.toInt()`
      if (to.bits !== 32 && from.bits === 32) return `${target}.toLong()`
      return expr
    }
    if (isPrimitive(to, 'string')) {
      if (isPrimitive(from, 'string')) return expr
      if (from.kind === 'enum') return `${target}.name`
      return `${target}.toString()`
    }
    if (isPrimitive(from, 'string', 'any')) {
      const text = isPrimitive(from, 'any') ? `${target}.toString()` : target
      if (to.kind === 'primitive') {
        switch (to.name) {
          case 'integer':
            return to.bits === 32 ? `${text}.toInt()` : `${text}.toLong()`
          case 'float':
            return `${text}.toDouble()`
          case 'decimal':
            this.use('java.math.BigDecimal')
            return `${text}.toBigDecimal()`
          case 'datetime':
            this.use(`java.time.${this.targetDateTime}`)
            return `${this.targetDateTime}.parse(${text})`
          case 'date':
            this.use('java.time.LocalDate')
            return `LocalDate.parse(${text})`
          case 'time':
            this.use('java.time.LocalTime')
            return `LocalTime.parse(${text})`
          case 'duration':
            this.use('java.time.Duration')
            return `Duration.parse(${text})`
          case 'uuid':
            this.use('java.util.UUID')
            return `UUID.fromString(${text})`
        }
      }
      if (to.kind === 'enum') return `${typeName(to.name)}.valueOf(${text})`
    }
    if (isPrimitive(from, 'date') && isPrimitive(to, 'datetime')) {
      this.use('java.time.ZoneOffset')
      if (this.targetDateTime === 'LocalDateTime') return `${target}.atStartOfDay()`
      if (this.targetDateTime === 'Instant') return `${target}.atStartOfDay().toInstant(ZoneOffset.UTC)`
      return `${target}.atStartOfDay().atOffset(ZoneOffset.UTC)`
    }
    if (isPrimitive(from, 'datetime') && isPrimitive(to, 'date')) {
      if (this.sourceDateTime === 'Instant') {
        this.use('java.time.ZoneOffset')
        return `${target}.atOffset(ZoneOffset.UTC).toLocalDate()`
      }
      return `${target}.toLocalDate()`
    }
    if (isPrimitive(from, 'boolean') && isPrimitive(to, 'integer')) return `if (${expr}) 1 else 0`
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
      const branches = node.pairs.map(
        (pair) => `${source ? this.enumMember(source, pair.from) : quote(pair.from)} -> ${this.enumMember(node.target, pair.to)}`,
      )
      const complete = source !== undefined && node.pairs.length >= source.values.length
      if (node.fallback !== undefined) branches.push(`else -> ${this.enumMember(node.target, node.fallback)}`)
      else if (!complete) branches.push(`else -> throw IllegalArgumentException("Unexpected ${source?.name ?? 'value'}: $value")`)
      const parameter = source ? typeName(source.name) : 'String'
      const code = `private fun ${name}(value: ${parameter}): ${target} = when (value) {\n${indent(branches.join('\n'), 4)}\n}`
      this.helpers.set(name, { key, code })
    }
    return name
  }

  syntax(): Syntax {
    return {
      access: (base, _step, name) => (base === 'this' ? name : `${base}.${name}`),
      safeAccess: (base, _step, name) => `${base}?.${name}`,
      literal: (value, type) => this.literal(value, type),
      convert: (expr, from, to) => this.convert(expr, from, to),
      concat: (parts, separator) => template(parts, separator),
      split: (expr, separator, part) => {
        const sep = quote(separator)
        if (part === 0) return `${operand(expr)}.substringBefore(${sep})`
        if (part === 'rest') return `${operand(expr)}.substringAfter(${sep}, "")`
        if (part === 'last') return `${operand(expr)}.substringAfterLast(${sep})`
        return `${operand(expr)}.split(${sep}).getOrElse(${part}) { "" }`
      },
      boolean: (expr, trueValues, from) => {
        const enumDef = from.kind === 'enum' ? findEnum(this.plan.source, from.name) : undefined
        const values = trueValues.map((value) => (enumDef ? this.enumMember(enumDef, value) : quote(value)))
        return values.length === 1 ? `${expr} == ${values[0]}` : `${expr} in setOf(${values.join(', ')})`
      },
      enumMap: (expr, node) => `${this.enumHelper({ ...node, type: { kind: 'enum', name: node.target.name }, nullable: false })}(${expr})`,
      epoch: (expr, unit, toDate, from) => {
        this.use('java.time.Instant')
        if (toDate) {
          const whole = isPrimitive(from, 'float') ? `${operand(expr)}.toLong()` : expr
          const instant = unit === 'seconds' ? `Instant.ofEpochSecond(${whole})` : `Instant.ofEpochMilli(${whole})`
          if (this.targetDateTime === 'Instant') return instant
          this.use('java.time.ZoneOffset')
          if (this.targetDateTime === 'OffsetDateTime') return `${instant}.atOffset(ZoneOffset.UTC)`
          this.use(`java.time.${this.targetDateTime}`)
          return `${this.targetDateTime}.ofInstant(${instant}, ZoneOffset.UTC)`
        }
        const instant = this.sourceDateTime === 'Instant' ? operand(expr) : `${operand(expr)}.toInstant()`
        return unit === 'seconds' ? `${instant}.epochSecond` : `${instant}.toEpochMilli()`
      },
      arithmetic: (expr, operator, value, type) => {
        if (isPrimitive(type, 'decimal')) {
          if (operator === '/') {
            this.use('java.math.BigDecimal')
            this.use('java.math.MathContext')
            return `${operand(expr)}.divide(BigDecimal.valueOf(${value}L), MathContext.DECIMAL128)`
          }
          return `${operand(expr)} ${operator} ${value}.toBigDecimal()`
        }
        return `${operand(expr)} ${operator} ${isPrimitive(type, 'float') && Number.isInteger(value) ? `${value}.0` : value}`
      },
      mapperCall: (mapper, expr) =>
        expr === 'this' ? `${this.functionName(mapper)}()` : `${operand(expr)}.${this.functionName(mapper)}()`,
      list: (expr, item, element, isMap, elementIsItem, container) => {
        const isSet = /Set$/.test(container ?? '')
        if (isMap) return elementIsItem ? `${operand(expr)}.toMap()` : `${operand(expr)}.mapValues { (_, ${item}) -> ${element} }`
        if (elementIsItem) return `${operand(expr)}.${isSet ? 'toSet()' : 'toList()'}`
        const call = new RegExp(`^${item}\\.(\\w+)\\(\\)$`).exec(element)
        const mapped = call ? `${operand(expr)}.map { it.${call[1]}() }` : `${operand(expr)}.map { ${item} -> ${element} }`
        return isSet ? `${mapped}.toSet()` : mapped
      },
      coalesce: (expr, fallback) => `${expr} ?: ${fallback}`,
      nullSafe: (expr, build, context) => {
        const marker = '\u0000'
        const built = build(marker)
        if (built.startsWith(`${marker}.`) && !built.slice(1).includes(marker)) return `${operand(expr)}?${built.slice(1)}`
        return `${operand(expr)}?.let { ${context.variable} -> ${build(context.variable)} }`
      },
      unwrap: (expr) => `requireNotNull(${expr}) { "A required value is missing in the source" }`,
      placeholder: (_type, field) => `TODO("No value for ${field.name} in the mapping")`,
      expression: {
        binary: (operator, left, right) => `${left} ${operator === '??' ? '?:' : operator} ${right}`,
        not: (value) => `!${operand(value)}`,
        conditional: (condition, then, otherwise) => `if (${condition}) ${then} else ${otherwise}`,
        call: (name, args) => {
          const [a, b, c] = args
          switch (name) {
            case 'upper':
              return `${operand(a)}.uppercase()`
            case 'lower':
              return `${operand(a)}.lowercase()`
            case 'trim':
              return `${operand(a)}.trim()`
            case 'length':
              return `${operand(a)}.length`
            case 'concat':
              return template(args, '')
            case 'substring':
              return c === undefined ? `${operand(a)}.substring(${b})` : `${operand(a)}.substring(${b}, ${operand(b)} + ${operand(c)})`
            case 'replace':
              return `${operand(a)}.replace(${b}, ${c})`
            case 'round':
            case 'floor':
            case 'ceil':
            case 'abs':
              this.use(`kotlin.math.${name}`)
              return `${name}(${a})`
            case 'min':
              return `minOf(${a}, ${b})`
            case 'max':
              return `maxOf(${a}, ${b})`
            case 'toString':
              return `${operand(a)}.toString()`
            case 'toNumber':
              return `${operand(a)}.toDouble()`
          }
        },
      },
    }
  }

  mapperFunction(mapper: MapperPlan): string {
    const roots = { source: 'this', item: 'item', depth: 0, lists: 0 }
    const target = typeName(mapper.target.name)
    const lines: string[] = []
    for (const assignment of mapper.assignments) {
      const code = this.emitter.assignment(assignment, roots)
      if (code === null) continue
      lines.push(`${this.name(assignment.field, 'target')} = ${code},`)
    }
    const signature = `fun ${typeName(mapper.source.name)}.${this.functionName(mapper)}(): ${target}`
    if (mapper.target.construction === 'properties') {
      const statements = lines.map((line) => `target.${line.replace(/,$/, '')}`)
      return `${signature} {\n    val target = ${target}()\n${indent(statements.join('\n'), 4)}\n    return target\n}`
    }
    return lines.length > 0 ? `${signature} = ${target}(\n${indent(lines.join('\n'), 4)}\n)` : `${signature} = ${target}()`
  }
}

function generate(plan: Plan, settings: GenerateSettings): GeneratedCode {
  const writer = new KotlinWriter(plan, settings)
  const functions = plan.mappers.map((mapper) => writer.mapperFunction(mapper))
  const helpers = [...writer.helpers.values()].map((helper) => helper.code)
  const pkg = optionValue(kotlinGenerator, plan, settings, 'package')
  const imports = [...writer.imports].sort().map((item) => `import ${item}`)
  const header = [pkg ? `package ${pkg}` : '', imports.join('\n')].filter((part) => part !== '').join('\n\n')
  const code = `${[header, ...functions, ...helpers].filter((part) => part !== '').join('\n\n')}\n`
  return { files: [{ name: `${typeName(plan.root.source.name)}Mappers.kt`, code }], notes: writer.emitter.notes }
}

export const kotlinGenerator: CodeGenerator = {
  id: 'kotlin',
  label: 'Kotlin',
  editorLanguage: 'kotlin',
  modes: ['extensions'],
  options: [{ id: 'package', kind: 'text', choices: [''] }],
  defaults: (plan) => {
    const namespace = plan.target.origin?.language === 'kotlin' ? plan.root.target.namespace : undefined
    return namespace ? { package: namespace } : ({} as Record<string, string>)
  },
  generate,
}
