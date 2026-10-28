import { findEnum, type EnumDef, type FieldDef, type Literal, type ModelSchema, type TypeRef } from '../../model/schema.ts'
import { Emitter, indent, type Syntax } from '../emitter.ts'
import { fieldName, isValidIdentifier, typeName, type NamingRules } from '../naming.ts'
import { allValues, planForPlainObjects, type MapperPlan, type Plan, type Value } from '../plan.ts'
import { optionValue, type CodeGenerator, type GeneratedCode, type GenerateSettings } from '../types.ts'

const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
])

function rules(language: 'typescript' | 'javascript'): NamingRules {
  return { language, convention: 'camelCase', reserved: RESERVED, escape: (name) => `${name}_`, rawObjects: true }
}

function single(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

/** A property key or member access: `name`, or `['display-name']` when it is not an identifier. */
function member(base: string, name: string, optional: boolean): string {
  if (isValidIdentifier(name)) return `${base}${optional ? '?.' : '.'}${name}`
  return `${base}${optional ? '?.' : ''}[${single(name)}]`
}

function propertyKey(name: string): string {
  return isValidIdentifier(name) ? name : single(name)
}

/** Wraps an expression in parentheses when it is not a simple operand (before `.method()`). */
function operand(code: string): string {
  return /^[\w$.?[\]'"()]+$/.test(code) && !/[?]{2}/.test(code) && !code.includes(' ') ? code : `(${code})`
}

const isNumber = (type: TypeRef) => type.kind === 'primitive' && ['integer', 'float', 'decimal'].includes(type.name)
const isText = (type: TypeRef) => type.kind === 'primitive' && ['string', 'uuid', 'time', 'duration'].includes(type.name)
const isDate = (type: TypeRef) => type.kind === 'primitive' && ['datetime', 'date'].includes(type.name)

class TypeScriptWriter {
  readonly plan: Plan
  readonly settings: GenerateSettings
  readonly typed: boolean
  readonly emitter: Emitter
  /** Helper functions for enum conversions, by name */
  readonly helpers = new Map<string, { key: string; code: string }>()
  /** Names used in code for the source and target models (renamed when both sides use the same name) */
  readonly sourceNames = new Map<string, string>()
  readonly targetNames = new Map<string, string>()

  constructor(plan: Plan, settings: GenerateSettings, typed: boolean) {
    this.plan = plan
    this.settings = settings
    this.typed = typed
    const naming = rules(typed ? 'typescript' : 'javascript')
    this.emitter = new Emitter(this.syntax(), (field, _owner, side) =>
      fieldName(field, side === 'source' ? plan.source : plan.target, naming, settings.naming),
    )
    const targetModels = new Set([...plan.mappers.map((mapper) => mapper.target.name), ...plan.enums.target.map((item) => item.name)])
    for (const name of targetModels) this.targetNames.set(name, typeName(name))
    for (const name of [...plan.mappers.map((mapper) => mapper.source.name), ...plan.enums.source.map((item) => item.name)]) {
      const code = typeName(name)
      this.sourceNames.set(name, targetModels.has(name) ? `Source${code}` : code)
    }
  }

  private typeName(type: TypeRef, side: 'source' | 'target'): string {
    switch (type.kind) {
      case 'primitive':
        if (isNumber(type)) return 'number'
        if (type.name === 'boolean') return 'boolean'
        if (isDate(type)) return 'Date'
        if (type.name === 'any') return 'unknown'
        if (type.name === 'binary') return 'Uint8Array'
        return 'string'
      case 'array':
        return `${this.typeName(type.items, side)}[]`
      case 'map':
        return `Record<string, ${this.typeName(type.value, side)}>`
      case 'model':
      case 'enum':
        return (side === 'source' ? this.sourceNames : this.targetNames).get(type.name) ?? typeName(type.name)
      case 'unknown':
        return 'unknown'
    }
  }

  private enumValue(enumDef: EnumDef, name: string, side: 'source' | 'target'): string {
    const value = enumDef.values.find((item) => item.name === name)
    if (enumDef.kind === 'literals') return single(String(value?.value ?? name))
    const owner = (side === 'source' ? this.sourceNames : this.targetNames).get(enumDef.name) ?? enumDef.name
    return isValidIdentifier(name) ? `${owner}.${name}` : `${owner}[${single(name)}]`
  }

  mapperName(mapper: MapperPlan): string {
    return `map${typeName(mapper.source.name)}To${typeName(mapper.target.name)}`
  }

  private enumHelper(node: Extract<Value, { k: 'enumMap' }>, from: TypeRef): string {
    const source = node.source
    const targetName = this.targetNames.get(node.target.name) ?? node.target.name
    const base = source ? `map${this.sourceNames.get(source.name) ?? source.name}To${targetName}` : `to${targetName}`
    const key = JSON.stringify([node.pairs, node.fallback, source?.name])
    let name = base
    for (let n = 2; this.helpers.has(name) && this.helpers.get(name)!.key !== key; n++) name = `${base}${n}`
    if (!this.helpers.has(name)) {
      const parameter = this.typed ? `value: ${this.typeName(from, 'source')}` : 'value'
      const returns = this.typed ? `: ${targetName}` : ''
      const cases = node.pairs.map((pair) => {
        const label = source ? this.enumValue(source, pair.from, 'source') : single(pair.from)
        return `    case ${label}:\n      return ${this.enumValue(node.target, pair.to, 'target')}`
      })
      const fallback =
        node.fallback !== undefined
          ? `    default:\n      return ${this.enumValue(node.target, node.fallback, 'target')}`
          : `    default:\n      throw new Error(\`Unexpected ${source?.name ?? 'value'}: \${String(value)}\`)`
      const doc = this.typed ? '' : `/** @param {${this.typeName(from, 'source')}} value @returns {${targetName}} */\n`
      const code = `${doc}function ${name}(${parameter})${returns} {\n  switch (value) {\n${[...cases, fallback].join('\n')}\n  }\n}`
      this.helpers.set(name, { key, code })
    }
    return name
  }

  private literal(value: Literal, type: TypeRef): string {
    if (value === null) return 'null'
    if (type.kind === 'enum' && typeof value === 'string') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef) return this.enumValue(enumDef, value, 'target')
    }
    if (typeof value === 'string') return isDate(type) ? `new Date(${single(value)})` : single(value)
    return String(value)
  }

  syntax(): Syntax {
    const typed = this.typed
    const syntax: Syntax = {
      access: (base, _step, name) => member(base, name, false),
      safeAccess: (base, _step, name) => member(base, name, true),
      literal: (value, type) => this.literal(value, type),
      convert: (expr, from, to) => {
        if (isNumber(from) && isNumber(to))
          return to.kind === 'primitive' && to.name === 'integer' && !(from.kind === 'primitive' && from.name === 'integer')
            ? `Math.trunc(${expr})`
            : expr
        if (to.kind === 'primitive' && to.name === 'string') {
          if (isDate(from)) return `${operand(expr)}.toISOString()`
          if (isText(from) || (from.kind === 'enum' && findEnum(this.plan.source, from.name)?.kind === 'literals')) return expr
          return `String(${expr})`
        }
        if (isText(from) && to.kind === 'primitive' && to.name === 'integer') return `Number.parseInt(${expr}, 10)`
        if (isText(from) && isNumber(to)) return `Number(${expr})`
        if (isText(from) && isDate(to)) return `new Date(${expr})`
        if (from.kind === 'primitive' && from.name === 'boolean' && isNumber(to)) return `(${expr} ? 1 : 0)`
        if (to.kind === 'enum' || (from.kind === 'primitive' && from.name === 'any'))
          return typed ? `(${expr} as ${this.typeName(to, 'target')})` : expr
        return expr
      },
      concat: (parts, separator) => `\`${parts.map((part) => `\${${part}}`).join(separator.replace(/[`\\$]/g, (char) => `\\${char}`))}\``,
      split: (expr, separator, part) => {
        const split = `${operand(expr)}.split(${single(separator)})`
        if (part === 'rest') return `${split}.slice(1).join(${single(separator)})`
        if (part === 'last') return `(${split}.at(-1) ?? '')`
        return `(${split}[${part}] ?? '')`
      },
      boolean: (expr, trueValues, from) => {
        const enumDef = from.kind === 'enum' ? findEnum(this.plan.source, from.name) : undefined
        const values = trueValues.map((value) => (enumDef ? this.enumValue(enumDef, value, 'source') : single(value)))
        return values.length === 1 ? `${expr} === ${values[0]}` : `[${values.join(', ')}].includes(${expr})`
      },
      enumMap: (expr, node, from) =>
        `${this.enumHelper({ ...node, type: { kind: 'enum', name: node.target.name }, nullable: false }, from)}(${expr})`,
      epoch: (expr, unit, toDate) => {
        if (toDate) return unit === 'seconds' ? `new Date(${operand(expr)} * 1000)` : `new Date(${expr})`
        return unit === 'seconds' ? `Math.floor(${operand(expr)}.getTime() / 1000)` : `${operand(expr)}.getTime()`
      },
      arithmetic: (expr, operator, value) => `${operand(expr)} ${operator} ${value}`,
      mapperCall: (mapper, expr) => `${this.mapperName(mapper)}(${expr})`,
      list: (expr, item, element, isMap, elementIsItem) => {
        if (isMap)
          return elementIsItem ? `{ ...${expr} }` : `Object.fromEntries(Object.entries(${expr}).map(([key, ${item}]) => [key, ${element}]))`
        if (elementIsItem) return `[...${expr}]`
        const call = /^(\w+)\((\w+)\)$/.exec(element)
        if (call && call[2] === item) return `${operand(expr)}.map(${call[1]})`
        return `${operand(expr)}.map((${item}) => ${element})`
      },
      coalesce: (expr, fallback) => `${expr} ?? ${fallback}`,
      nullSafe: (expr, build) => `${expr} == null ? undefined : ${build(expr)}`,
      unwrap: (expr) => (typed ? `${operand(expr)}!` : expr),
      placeholder: (type) => this.placeholder(type),
      expression: {
        binary: (operator, left, right) => `${left} ${operator === '==' ? '===' : operator === '!=' ? '!==' : operator} ${right}`,
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
              return `\`${args.map((arg) => `\${${arg}}`).join('')}\``
            case 'substring':
              return c === undefined ? `${operand(a)}.substring(${b})` : `${operand(a)}.substring(${b}, ${operand(b)} + ${operand(c)})`
            case 'replace':
              return `${operand(a)}.replaceAll(${b}, ${c})`
            case 'round':
            case 'floor':
            case 'ceil':
            case 'abs':
            case 'min':
            case 'max':
              return `Math.${name}(${args.join(', ')})`
            case 'toString':
              return `String(${a})`
            case 'toNumber':
              return `Number(${a})`
          }
        },
      },
    }
    return syntax
  }

  private placeholder(type: TypeRef): string {
    if (type.kind === 'array') return '[]'
    if (type.kind === 'map') return '{}'
    if (type.kind === 'enum') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef?.values[0]) return this.enumValue(enumDef, enumDef.values[0].name, 'target')
    }
    if (type.kind === 'primitive') {
      if (isNumber(type)) return '0'
      if (type.name === 'boolean') return 'false'
      if (isDate(type)) return 'new Date(0)'
      if (type.name === 'string' || isText(type)) return "''"
    }
    return this.typed ? `undefined as unknown as ${this.typeName(type, 'target')}` : 'undefined'
  }

  private targetFieldName(field: FieldDef): string {
    return fieldName(field, this.plan.target, rules(this.typed ? 'typescript' : 'javascript'), this.settings.naming)
  }

  mapperFunction(mapper: MapperPlan): string {
    const roots = { source: 'source', item: 'item', depth: 0, lists: 0 }
    const lines: string[] = []
    for (const assignment of mapper.assignments) {
      let code = this.emitter.assignment(assignment, roots)
      if (code === null) continue
      const key = propertyKey(this.targetFieldName(assignment.field))
      if (assignment.missing) lines.push(`// TODO: no value for "${assignment.field.name}" in the mapping`)
      else if (assignment.unsafeNull) lines.push(`// TODO: the source may be missing, but "${assignment.field.name}" is required`)
      else if (assignment.value?.nullable && assignment.field.nullable && !assignment.field.optional) code = `${code} ?? null`
      lines.push(code === key ? `${key},` : `${key}: ${code},`)
    }
    const sourceType = this.sourceNames.get(mapper.source.name) ?? mapper.source.name
    const targetType = this.targetNames.get(mapper.target.name) ?? mapper.target.name
    const body = lines.length > 0 ? `{\n${indent(lines.join('\n'), 4)}\n  }` : '{}'
    const isClass = mapper.target.kind === 'class' || mapper.target.kind === 'entity'
    const result = isClass ? `Object.assign(new ${targetType}(), ${body.replace(/\n {2}\}$/, '\n  })')}` : body
    if (this.typed) return `export function ${this.mapperName(mapper)}(source: ${sourceType}): ${targetType} {\n  return ${result}\n}`
    return `/**\n * @param {${sourceType}} source\n * @returns {${targetType}}\n */\nexport function ${this.mapperName(mapper)}(source) {\n  return ${result}\n}`
  }

  imports(): string {
    if (!this.typed) return ''
    const usedSource = new Set<string>()
    const usedTarget = new Set<string>()
    for (const mapper of this.plan.mappers) {
      usedSource.add(mapper.source.name)
      usedTarget.add(mapper.target.name)
    }
    for (const value of allValues(this.plan)) {
      if (value.k === 'enumMap') {
        usedTarget.add(value.target.name)
        if (value.source) usedSource.add(value.source.name)
      }
      if (value.k === 'boolean' && value.value.type.kind === 'enum') usedSource.add(value.value.type.name)
      if (value.k === 'literal' && value.type.kind === 'enum') usedTarget.add(value.type.name)
    }
    for (const mapper of this.plan.mappers) {
      for (const assignment of mapper.assignments)
        if (assignment.missing && assignment.field.type.kind === 'enum') usedTarget.add(assignment.field.type.name)
    }
    // Enums and classes are values (`Status.Active`, `new User()`); interfaces and literal unions are types
    const isType = (schema: ModelSchema, name: string) => {
      const enumDef = findEnum(schema, name)
      if (enumDef) return enumDef.kind === 'literals'
      const model = schema.models.find((item) => item.name === name)
      return !(model && schema === this.plan.target && (model.kind === 'class' || model.kind === 'entity'))
    }
    const sourceModule = optionValue(typeScriptGenerator, this.plan, this.settings, 'sourceModule')
    let targetModule = optionValue(typeScriptGenerator, this.plan, this.settings, 'targetModule')
    const renamed = [...this.sourceNames.entries()].some(([name, code]) => name !== code && usedSource.has(name))
    if (renamed && targetModule === sourceModule) targetModule = './target-models'
    const statement = (names: Set<string>, schema: ModelSchema, codeNames: Map<string, string>, module: string) => {
      if (names.size === 0) return []
      const entries = [...names].sort().map((name) => {
        const code = codeNames.get(name) ?? name
        const typeOnly = isType(schema, name)
        const imported = code === typeName(name) ? code : `${typeName(name)} as ${code}`
        return { text: typeOnly ? `type ${imported}` : imported, typeOnly }
      })
      return entries.every((entry) => entry.typeOnly)
        ? [`import type { ${entries.map((entry) => entry.text.replace(/^type /, '')).join(', ')} } from ${single(module)}`]
        : [`import { ${entries.map((entry) => entry.text).join(', ')} } from ${single(module)}`]
    }
    if (sourceModule === targetModule) {
      const merged = new Set([...usedSource, ...usedTarget])
      const names = new Map([...this.sourceNames, ...this.targetNames])
      return statement(
        merged,
        {
          ...this.plan.target,
          models: [...this.plan.source.models, ...this.plan.target.models],
          enums: [...this.plan.source.enums, ...this.plan.target.enums],
        },
        names,
        sourceModule,
      ).join('\n')
    }
    return [
      ...statement(usedSource, this.plan.source, this.sourceNames, sourceModule),
      ...statement(usedTarget, this.plan.target, this.targetNames, targetModule),
    ].join('\n')
  }
}

function generate(original: Plan, settings: GenerateSettings, typed: boolean): GeneratedCode {
  // JSON read with JSON.parse keeps dates and ids as text
  const plan = planForPlainObjects(original, true, true)
  const writer = new TypeScriptWriter(plan, settings, typed)
  const functions = plan.mappers.map((mapper) => writer.mapperFunction(mapper))
  const helpers = [...writer.helpers.values()].map((helper) => helper.code)
  const imports = writer.imports()
  const code = [imports, ...functions, ...helpers].filter((part) => part !== '').join('\n\n') + '\n'
  return { files: [{ name: typed ? 'mapper.ts' : 'mapper.js', code }], notes: writer.emitter.notes }
}

export const typeScriptGenerator: CodeGenerator = {
  id: 'typescript',
  label: 'TypeScript',
  editorLanguage: 'typescript',
  modes: ['functions'],
  options: [
    { id: 'sourceModule', choices: ['./models', './source-models', './dto'] },
    { id: 'targetModule', choices: ['./models', './target-models', './entities'] },
  ],
  generate: (plan, settings) => generate(plan, settings, true),
}

export const javaScriptGenerator: CodeGenerator = {
  id: 'javascript',
  label: 'JavaScript',
  editorLanguage: 'javascript',
  modes: ['functions'],
  options: [],
  generate: (plan, settings) => generate(plan, settings, false),
}
