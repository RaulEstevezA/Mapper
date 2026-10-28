import { toPascalCase } from '../../model/naming.ts'
import { findEnum, type EnumDef, type FieldDef, type Literal, type ModelDef, type ModelSchema, type TypeRef } from '../../model/schema.ts'
import { Emitter, indent, type Syntax } from '../emitter.ts'
import { fieldName, isValidIdentifier, typeName, type NamingRules } from '../naming.ts'
import { isDocumentSchema, planForPlainObjects, type MapperPlan, type Plan, type Value } from '../plan.ts'
import { optionValue, type CodeGenerator, type GeneratedCode, type GenerateSettings } from '../types.ts'

const NAMING: NamingRules = { language: 'php', convention: 'camelCase', reserved: new Set(), escape: (name) => name }

const isPrimitive = (type: TypeRef, ...names: string[]) => type.kind === 'primitive' && names.includes(type.name)
const isNumber = (type: TypeRef) => isPrimitive(type, 'integer', 'float', 'decimal')

function single(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function operand(code: string): string {
  return /^[\w$>[\]'()-]+$/.test(code) && !code.includes(' ') ? code : `(${code})`
}

class PhpWriter {
  readonly plan: Plan
  readonly settings: GenerateSettings
  readonly sourceArray: boolean
  readonly targetArray: boolean
  readonly emitter: Emitter
  readonly helpers = new Map<string, { key: string; code: string }>()

  constructor(plan: Plan, settings: GenerateSettings, sourceArray: boolean, targetArray: boolean) {
    this.plan = plan
    this.settings = settings
    this.sourceArray = sourceArray
    this.targetArray = targetArray
    this.emitter = new Emitter(this.syntax(), (field, _owner, side) => this.name(field, side))
  }

  name(field: FieldDef, side: 'source' | 'target'): string {
    if (side === 'source' ? this.sourceArray : this.targetArray) return field.name
    return fieldName(field, side === 'source' ? this.plan.source : this.plan.target, NAMING, this.settings.naming)
  }

  enumCase(enumDef: EnumDef, name: string, side: 'source' | 'target'): string {
    const array = side === 'source' ? this.sourceArray : this.targetArray
    const value = enumDef.values.find((item) => item.name === name)
    if (array || enumDef.kind === 'literals')
      return typeof value?.value === 'number' ? String(value.value) : single(String(value?.value ?? name))
    return `${typeName(enumDef.name)}::${isValidIdentifier(name) ? name : toPascalCase(name) || 'Value'}`
  }

  methodName(mapper: MapperPlan): string {
    return `to${typeName(mapper.target.name)}`
  }

  literal(value: Literal, type: TypeRef): string {
    if (value === null) return 'null'
    if (type.kind === 'enum' && typeof value === 'string') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef) return this.enumCase(enumDef, value, 'target')
    }
    if (typeof value === 'number') return isPrimitive(type, 'float', 'decimal') && Number.isInteger(value) ? `${value}.0` : String(value)
    if (typeof value === 'boolean') return String(value)
    if (isPrimitive(type, 'datetime', 'date') && !this.targetArray) return `new \\DateTimeImmutable(${single(value)})`
    return single(value)
  }

  convert(expr: string, from: TypeRef, to: TypeRef): string {
    if (isNumber(from) && isNumber(to))
      return isPrimitive(to, 'integer') && !isPrimitive(from, 'integer')
        ? `(int) ${operand(expr)}`
        : isPrimitive(to, 'float', 'decimal') && isPrimitive(from, 'integer')
          ? `(float) ${operand(expr)}`
          : expr
    if (isPrimitive(to, 'string')) {
      if (isPrimitive(from, 'string', 'uuid')) return expr
      if (from.kind === 'enum')
        return this.sourceArray || findEnum(this.plan.source, from.name)?.kind === 'literals' ? expr : `${operand(expr)}->value`
      if (isPrimitive(from, 'datetime')) return `${operand(expr)}->format(\\DATE_ATOM)`
      if (isPrimitive(from, 'date')) return `${operand(expr)}->format('Y-m-d')`
      return `(string) ${operand(expr)}`
    }
    if (isPrimitive(from, 'string', 'any')) {
      if (isPrimitive(to, 'integer')) return `(int) ${operand(expr)}`
      if (isPrimitive(to, 'float', 'decimal')) return `(float) ${operand(expr)}`
      if (isPrimitive(to, 'datetime', 'date')) return `new \\DateTimeImmutable(${expr})`
      if (to.kind === 'enum')
        return this.targetArray || findEnum(this.plan.target, to.name)?.kind === 'literals' ? expr : `${typeName(to.name)}::from(${expr})`
    }
    if (isPrimitive(from, 'boolean') && isPrimitive(to, 'integer')) return `(int) ${operand(expr)}`
    return expr
  }

  private enumHelper(node: Extract<Value, { k: 'enumMap' }>): string {
    const source = node.source
    const target = this.targetArray ? 'string' : typeName(node.target.name)
    const base = `to${typeName(node.target.name)}`
    const key = JSON.stringify([node.pairs, node.fallback, source?.name])
    let name = base
    for (let n = 2; this.helpers.has(name) && this.helpers.get(name)!.key !== key; n++) name = `${base}${n}`
    if (!this.helpers.has(name)) {
      const arms = node.pairs.map(
        (pair) =>
          `${source ? this.enumCase(source, pair.from, 'source') : single(pair.from)} => ${this.enumCase(node.target, pair.to, 'target')},`,
      )
      arms.push(
        node.fallback !== undefined
          ? `default => ${this.enumCase(node.target, node.fallback, 'target')},`
          : `default => throw new \\UnexpectedValueException(${single(`Unexpected ${source?.name ?? 'value'}`)}),`,
      )
      const parameter = source && !this.sourceArray ? typeName(source.name) : 'string'
      const code = `    private static function ${name}(${parameter} $value): ${target}\n    {\n        return match ($value) {\n${indent(arms.join('\n'), 12)}\n        };\n    }`
      this.helpers.set(name, { key, code })
    }
    return name
  }

  private read(owner: ModelDef, name: string): string {
    return owner.metadata?.accessors === 'getters' ? `get${name.charAt(0).toUpperCase()}${name.slice(1)}()` : name
  }

  syntax(): Syntax {
    return {
      access: (base, step, name) =>
        this.sourceArray ? `${base}[${single(name)}]${step.nullable ? ' ?? null' : ''}` : `${base}->${this.read(step.owner, name)}`,
      safeAccess: (base, step, name) =>
        this.sourceArray ? `(${base})[${single(name)}] ?? null` : `${base}?->${this.read(step.owner, name)}`,
      literal: (value, type) => this.literal(value, type),
      convert: (expr, from, to) => this.convert(expr, from, to),
      concat: (parts, separator) => parts.map(operand).join(` . ${single(separator)} . `),
      split: (expr, separator, part) => {
        const sep = single(separator)
        if (part === 0) return `explode(${sep}, ${expr})[0]`
        if (part === 'last') return `array_slice(explode(${sep}, ${expr}), -1)[0]`
        if (part === 'rest') return `explode(${sep}, ${expr}, 2)[1] ?? ''`
        return `explode(${sep}, ${expr})[${part}] ?? ''`
      },
      boolean: (expr, trueValues, from) => {
        const enumDef = from.kind === 'enum' ? findEnum(this.plan.source, from.name) : undefined
        const values = trueValues.map((value) => (enumDef ? this.enumCase(enumDef, value, 'source') : single(value)))
        return values.length === 1 ? `${operand(expr)} === ${values[0]}` : `in_array(${expr}, [${values.join(', ')}], true)`
      },
      enumMap: (expr, node) =>
        `self::${this.enumHelper({ ...node, type: { kind: 'enum', name: node.target.name }, nullable: false })}(${expr})`,
      epoch: (expr, unit, toDate) => {
        if (toDate) return `(new \\DateTimeImmutable())->setTimestamp((int) ${unit === 'seconds' ? operand(expr) : `(${expr} / 1000)`})`
        return unit === 'seconds' ? `${operand(expr)}->getTimestamp()` : `(int) ${operand(expr)}->format('Uv')`
      },
      arithmetic: (expr, operator, value) => `${operand(expr)} ${operator} ${value}`,
      mapperCall: (mapper, expr) => `self::${this.methodName(mapper)}(${expr})`,
      list: (expr, item, element, _isMap, elementIsItem) => {
        if (elementIsItem) return expr
        // array_map keeps the keys, so it maps lists and dictionaries alike
        const call = /^self::(\w+)\((\$\w+)\)$/.exec(element)
        return call && call[2] === item ? `array_map(self::${call[1]}(...), ${expr})` : `array_map(fn (${item}) => ${element}, ${expr})`
      },
      coalesce: (expr, fallback) => `${expr} ?? ${fallback}`,
      nullSafe: (expr, build) => `${operand(expr)} === null ? null : ${build(expr)}`,
      variablePrefix: '$',
      unwrap: (expr) => `${expr} ?? throw new \\InvalidArgumentException('A required value is missing in the source.')`,
      placeholder: (_type, field) => `throw new \\LogicException(${single(`No value for ${field.name} in the mapping`)})`,
      expression: {
        binary: (operator, left, right) =>
          `${left} ${operator === '==' ? '===' : operator === '!=' ? '!==' : operator === '+' && /^'/.test(left + right) ? '.' : operator} ${right}`,
        not: (value) => `!${operand(value)}`,
        conditional: (condition, then, otherwise) => `${condition} ? ${then} : ${otherwise}`,
        call: (name, args) => {
          const [a, b, c] = args
          switch (name) {
            case 'upper':
              return `mb_strtoupper(${a})`
            case 'lower':
              return `mb_strtolower(${a})`
            case 'trim':
              return `trim(${a})`
            case 'length':
              return `mb_strlen(${a})`
            case 'concat':
              return args.map((arg) => `(string) ${operand(arg)}`).join(' . ')
            case 'substring':
              return c === undefined ? `mb_substr(${a}, ${b})` : `mb_substr(${a}, ${b}, ${c})`
            case 'replace':
              return `str_replace(${b}, ${c}, ${a})`
            case 'round':
            case 'floor':
            case 'ceil':
            case 'abs':
            case 'min':
            case 'max':
              return `${name}(${args.join(', ')})`
            case 'toString':
              return `(string) ${operand(a)}`
            case 'toNumber':
              return `(float) ${operand(a)}`
          }
        },
      },
    }
  }

  method(mapper: MapperPlan): string {
    const roots = { source: '$source', item: 'item', depth: 0, lists: 0 }
    const values = mapper.assignments.map((assignment) => ({ assignment, code: this.emitter.assignment(assignment, roots) }))
    const sourceType = this.sourceArray ? 'array' : typeName(mapper.source.name)
    const targetType = this.targetArray ? 'array' : typeName(mapper.target.name)
    let body: string
    if (this.targetArray) {
      const lines = values
        .filter(({ code }) => code !== null)
        .map(({ assignment, code }) => `${single(this.name(assignment.field, 'target'))} => ${code},`)
      body = `return [\n${indent(lines.join('\n'), 4)}\n];`
    } else if (mapper.target.construction === 'named' || mapper.target.construction === 'positional') {
      const lines = values
        .filter(({ code }) => code !== null)
        .map(({ assignment, code }) => `${this.name(assignment.field, 'target')}: ${code},`)
      body = `return new ${targetType}(\n${indent(lines.join('\n'), 4)}\n);`
    } else {
      const setters = mapper.target.metadata?.accessors === 'getters'
      const lines = values
        .filter(({ code }) => code !== null)
        .map(({ assignment, code }) => {
          const name = this.name(assignment.field, 'target')
          return setters ? `$target->set${name.charAt(0).toUpperCase()}${name.slice(1)}(${code});` : `$target->${name} = ${code};`
        })
      body = [`$target = new ${targetType}();`, ...lines, 'return $target;'].join('\n')
    }
    return `    public static function ${this.methodName(mapper)}(${sourceType} $source): ${targetType}\n    {\n${indent(body, 8)}\n    }`
  }

  uses(): string[] {
    const uses = new Set<string>()
    const add = (schema: ModelSchema, item: { name: string; namespace?: string }, array: boolean) => {
      if (!array && schema.origin?.language === 'php' && item.namespace) uses.add(`${item.namespace}\\${typeName(item.name)}`)
    }
    for (const mapper of this.plan.mappers) {
      add(this.plan.source, mapper.source, this.sourceArray)
      add(this.plan.target, mapper.target, this.targetArray)
    }
    for (const enumDef of this.plan.enums.source) add(this.plan.source, enumDef, this.sourceArray)
    for (const enumDef of this.plan.enums.target) add(this.plan.target, enumDef, this.targetArray)
    return [...uses].sort()
  }
}

function generate(original: Plan, settings: GenerateSettings): GeneratedCode {
  const sourceArray = optionValue(phpGenerator, original, settings, 'sourceAccess') === 'array'
  const targetArray = optionValue(phpGenerator, original, settings, 'targetStyle') === 'array'
  const plan = planForPlainObjects(original, sourceArray, targetArray)
  const writer = new PhpWriter(plan, settings, sourceArray, targetArray)
  const methods = plan.mappers.map((mapper) => writer.method(mapper))
  const helpers = [...writer.helpers.values()].map((helper) => helper.code)
  const namespace = optionValue(phpGenerator, plan, settings, 'namespace')
  const name = `${typeName(plan.root.source.name)}Mapper`
  const uses = writer.uses().filter((item) => !namespace || item.slice(0, item.lastIndexOf('\\')) !== namespace)
  const header = [
    '<?php',
    'declare(strict_types=1);',
    namespace ? `namespace ${namespace};` : '',
    uses.map((item) => `use ${item};`).join('\n'),
  ]
    .filter((part) => part !== '')
    .join('\n\n')
  const code = `${header}\n\nfinal class ${name}\n{\n${[...methods, ...helpers].join('\n\n')}\n}\n`
  return { files: [{ name: `${name}.php`, code }], notes: writer.emitter.notes }
}

export const phpGenerator: CodeGenerator = {
  id: 'php',
  label: 'PHP',
  editorLanguage: 'php',
  modes: ['static'],
  options: [
    { id: 'sourceAccess', choices: ['object', 'array'] },
    { id: 'targetStyle', choices: ['object', 'array'] },
    { id: 'namespace', kind: 'text', choices: [''] },
  ],
  defaults: (plan) => ({
    sourceAccess: isDocumentSchema(plan.source) ? 'array' : 'object',
    targetStyle: isDocumentSchema(plan.target) ? 'array' : 'object',
    ...(plan.target.origin?.language === 'php' && plan.root.target.namespace ? { namespace: plan.root.target.namespace } : {}),
  }),
  generate,
}
