import { toCamelCase, toSnakeCase } from '../../model/naming.ts'
import { findEnum, type EnumDef, type FieldDef, type Literal, type TypeRef } from '../../model/schema.ts'
import { Emitter, indent, type Syntax } from '../emitter.ts'
import { fieldName, isValidIdentifier, typeName, type NamingRules } from '../naming.ts'
import type { MapperPlan, Plan, Value } from '../plan.ts'
import { optionValue, type CodeGenerator, type GeneratedCode, type GenerateSettings } from '../types.ts'

const RESERVED = new Set([
  'abstract',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'dynamic',
  'else',
  'enum',
  'export',
  'extends',
  'external',
  'factory',
  'false',
  'final',
  'finally',
  'for',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'is',
  'library',
  'new',
  'null',
  'operator',
  'part',
  'rethrow',
  'return',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'var',
  'void',
  'while',
  'with',
  'yield',
])
const NAMING: NamingRules = { language: 'dart', convention: 'camelCase', reserved: RESERVED, escape: (name) => `${name}_` }

const isPrimitive = (type: TypeRef, ...names: string[]) => type.kind === 'primitive' && names.includes(type.name)
const isNumber = (type: TypeRef) => isPrimitive(type, 'integer', 'float', 'decimal')

function single(text: string): string {
  return `'${text.replace(/[\\'$]/g, (char) => `\\${char}`).replace(/\n/g, '\\n')}'`
}

function operand(code: string): string {
  return /^[\w.()'!?]+$/.test(code) && !code.includes(' ') ? code : `(${code})`
}

class DartWriter {
  readonly plan: Plan
  readonly settings: GenerateSettings
  readonly emitter: Emitter
  readonly helpers = new Map<string, { key: string; code: string }>()
  usesMath = false

  constructor(plan: Plan, settings: GenerateSettings) {
    this.plan = plan
    this.settings = settings
    this.emitter = new Emitter(this.syntax(), (field, _owner, side) => this.name(field, side))
  }

  name(field: FieldDef, side: 'source' | 'target'): string {
    return fieldName(field, side === 'source' ? this.plan.source : this.plan.target, NAMING, this.settings.naming)
  }

  enumMember(enumDef: EnumDef, name: string, side: 'source' | 'target'): string {
    const schema = side === 'source' ? this.plan.source : this.plan.target
    const member = schema.origin?.language === 'dart' && isValidIdentifier(name) ? name : toCamelCase(name) || 'value'
    return `${typeName(enumDef.name)}.${RESERVED.has(member) ? `${member}_` : member}`
  }

  functionName(mapper: MapperPlan): string {
    return `to${typeName(mapper.target.name)}`
  }

  literal(value: Literal, type: TypeRef): string {
    if (value === null) return 'null'
    if (type.kind === 'enum' && typeof value === 'string') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef) return this.enumMember(enumDef, value, 'target')
    }
    if (typeof value === 'number') return isPrimitive(type, 'float', 'decimal') && Number.isInteger(value) ? `${value}.0` : String(value)
    if (typeof value === 'boolean') return String(value)
    if (isPrimitive(type, 'datetime', 'date')) return `DateTime.parse(${single(value)})`
    return single(value)
  }

  convert(expr: string, from: TypeRef, to: TypeRef): string {
    const target = operand(expr)
    if (isNumber(from) && isNumber(to)) {
      if (isPrimitive(to, 'integer') && !isPrimitive(from, 'integer')) return `${target}.toInt()`
      if (!isPrimitive(to, 'integer') && isPrimitive(from, 'integer')) return `${target}.toDouble()`
      return expr
    }
    if (isPrimitive(to, 'string')) {
      if (isPrimitive(from, 'string', 'uuid')) return expr
      if (from.kind === 'enum') return `${target}.name`
      if (isPrimitive(from, 'datetime', 'date')) return `${target}.toIso8601String()`
      return `${target}.toString()`
    }
    if (isPrimitive(from, 'string', 'any')) {
      const text = isPrimitive(from, 'any') ? `${target}.toString()` : expr
      if (isPrimitive(to, 'integer')) return `int.parse(${text})`
      if (isPrimitive(to, 'float', 'decimal')) return `double.parse(${text})`
      if (isPrimitive(to, 'datetime', 'date')) return `DateTime.parse(${text})`
      if (to.kind === 'enum') return `${typeName(to.name)}.values.byName(${text})`
    }
    if (isPrimitive(from, 'boolean') && isPrimitive(to, 'integer')) return `${expr} ? 1 : 0`
    return expr
  }

  private enumHelper(node: Extract<Value, { k: 'enumMap' }>): string {
    const source = node.source
    const target = typeName(node.target.name)
    const base = `_to${target}`
    const key = JSON.stringify([node.pairs, node.fallback, source?.name])
    let name = base
    for (let n = 2; this.helpers.has(name) && this.helpers.get(name)!.key !== key; n++) name = `${base}${n}`
    if (!this.helpers.has(name)) {
      const arms = node.pairs.map(
        (pair) =>
          `${source ? this.enumMember(source, pair.from, 'source') : single(pair.from)} => ${this.enumMember(node.target, pair.to, 'target')},`,
      )
      const complete = source !== undefined && node.pairs.length >= source.values.length
      if (node.fallback !== undefined) arms.push(`_ => ${this.enumMember(node.target, node.fallback, 'target')},`)
      else if (!complete) arms.push(`_ => throw ArgumentError.value(value, 'value', ${single(`Unexpected ${source?.name ?? 'value'}`)}),`)
      const code = `${target} ${name}(${source ? typeName(source.name) : 'String'} value) => switch (value) {\n${indent(arms.join('\n'), 6)}\n    };`
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
      concat: (parts, separator) => `'${parts.map((part) => `\${${part}}`).join(separator.replace(/[\\'$]/g, (char) => `\\${char}`))}'`,
      split: (expr, separator, part) => {
        const split = `${operand(expr)}.split(${single(separator)})`
        if (part === 0) return `${split}.first`
        if (part === 'last') return `${split}.last`
        if (part === 'rest') return `${split}.skip(1).join(${single(separator)})`
        return `${split}.elementAtOrNull(${part}) ?? ''`
      },
      boolean: (expr, trueValues, from) => {
        const enumDef = from.kind === 'enum' ? findEnum(this.plan.source, from.name) : undefined
        const values = trueValues.map((value) => (enumDef ? this.enumMember(enumDef, value, 'source') : single(value)))
        return values.length === 1 ? `${expr} == ${values[0]}` : `{${values.join(', ')}}.contains(${expr})`
      },
      enumMap: (expr, node) => `${this.enumHelper({ ...node, type: { kind: 'enum', name: node.target.name }, nullable: false })}(${expr})`,
      epoch: (expr, unit, toDate, from) => {
        if (toDate) {
          const millis = unit === 'seconds' ? `${operand(expr)} * 1000` : expr
          return `DateTime.fromMillisecondsSinceEpoch(${isPrimitive(from, 'float') ? `(${millis}).round()` : millis}, isUtc: true)`
        }
        return unit === 'seconds' ? `${operand(expr)}.millisecondsSinceEpoch ~/ 1000` : `${operand(expr)}.millisecondsSinceEpoch`
      },
      arithmetic: (expr, operator, value, type) => {
        if (operator === '/' && isPrimitive(type, 'integer')) return `${operand(expr)} ~/ ${value}`
        return `${operand(expr)} ${operator} ${value}`
      },
      mapperCall: (mapper, expr) =>
        expr === 'this' ? `${this.functionName(mapper)}()` : `${operand(expr)}.${this.functionName(mapper)}()`,
      list: (expr, item, element, isMap, elementIsItem, container) => {
        const isSet = /Set$/.test(container ?? '')
        if (isMap) return elementIsItem ? `Map.of(${expr})` : `${operand(expr)}.map((key, ${item}) => MapEntry(key, ${element}))`
        if (elementIsItem) return isSet ? `Set.of(${expr})` : `List.of(${expr})`
        return `${operand(expr)}.map((${item}) => ${element}).${isSet ? 'toSet()' : 'toList()'}`
      },
      coalesce: (expr, fallback) => `${expr} ?? ${fallback}`,
      nullSafe: (expr, build) => {
        const marker = '\u0000'
        const built = build(marker)
        if (built.startsWith(`${marker}.`) && !built.slice(1).includes(marker)) return `${operand(expr)}?${built.slice(1)}`
        // Fields cannot be promoted to non-null: the value is asserted inside the check
        return `${operand(expr)} == null ? null : ${build(`${operand(expr)}!`)}`
      },
      unwrap: (expr) => `${operand(expr)}!`,
      placeholder: (_type, field) => `throw UnimplementedError(${single(`No value for ${field.name} in the mapping`)})`,
      expression: {
        binary: (operator, left, right) => `${left} ${operator} ${right}`,
        not: (value) => `!${operand(value)}`,
        conditional: (condition, then, otherwise) => `${condition} ? ${then} : ${otherwise}`,
        call: (name, args) => {
          const [a, b, c] = args
          switch (name) {
            case 'upper':
              return `${operand(a)}.toUpperCase()`
            case 'lower':
              return `${operand(a)}.toLowerCase()`
            case 'trim':
              return `${operand(a)}.trim()`
            case 'length':
              return `${operand(a)}.length`
            case 'concat':
              return `'${args.map((arg) => `\${${arg}}`).join('')}'`
            case 'substring':
              return c === undefined ? `${operand(a)}.substring(${b})` : `${operand(a)}.substring(${b}, ${operand(b)} + ${operand(c)})`
            case 'replace':
              return `${operand(a)}.replaceAll(${b}, ${c})`
            case 'round':
            case 'floor':
            case 'ceil':
            case 'abs':
              return `${operand(a)}.${name}()`
            case 'min':
            case 'max':
              this.usesMath = true
              return `${name}(${a}, ${b})`
            case 'toString':
              return `${operand(a)}.toString()`
            case 'toNumber':
              return `double.parse(${a})`
          }
        },
      },
    }
  }

  extension(mapper: MapperPlan): string {
    const roots = { source: 'this', item: 'item', depth: 0, lists: 0 }
    const target = typeName(mapper.target.name)
    const named = mapper.target.construction !== 'positional'
    const lines: string[] = []
    for (const assignment of mapper.assignments) {
      const code = this.emitter.assignment(assignment, roots)
      if (code === null) {
        // Positional arguments cannot be skipped
        if (!named) lines.push('null,')
        continue
      }
      lines.push(named ? `${this.name(assignment.field, 'target')}: ${code},` : `${code},`)
    }
    const body = lines.length > 0 ? `${target}(\n${indent(lines.join('\n'), 8)}\n      )` : `${target}()`
    return `extension ${typeName(mapper.source.name)}Mapping on ${typeName(mapper.source.name)} {\n  ${target} ${this.functionName(mapper)}() => ${body};\n}`
  }
}

function generate(plan: Plan, settings: GenerateSettings): GeneratedCode {
  const writer = new DartWriter(plan, settings)
  const extensions = plan.mappers.map((mapper) => writer.extension(mapper))
  const helpers = [...writer.helpers.values()].map((helper) => helper.code)
  const module = optionValue(dartGenerator, plan, settings, 'modelsImport')
  const imports = [writer.usesMath ? "import 'dart:math';" : '', module ? `import ${single(module)};` : '']
    .filter((line) => line !== '')
    .join('\n\n')
  const code = `${[imports, ...extensions, ...helpers].filter((part) => part !== '').join('\n\n')}\n`
  return { files: [{ name: `${toSnakeCase(plan.root.source.name)}_mapping.dart`, code }], notes: writer.emitter.notes }
}

export const dartGenerator: CodeGenerator = {
  id: 'dart',
  label: 'Dart',
  editorLanguage: 'dart',
  modes: ['extensions'],
  options: [{ id: 'modelsImport', kind: 'text', choices: ['models.dart'] }],
  generate,
}
