import { toPascalCase } from '../../model/naming.ts'
import { findEnum, type EnumDef, type FieldDef, type Literal, type ModelSchema, type TypeRef } from '../../model/schema.ts'
import { Emitter, indent, quote, type Syntax } from '../emitter.ts'
import { fieldName, isValidIdentifier, typeName, type NamingRules } from '../naming.ts'
import type { Assignment, MapperPlan, Plan, Value } from '../plan.ts'
import { optionValue, type CodeGenerator, type GeneratedCode, type GenerateSettings } from '../types.ts'

const RESERVED = new Set([
  'abstract',
  'as',
  'base',
  'bool',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'checked',
  'class',
  'const',
  'continue',
  'decimal',
  'default',
  'delegate',
  'do',
  'double',
  'else',
  'enum',
  'event',
  'explicit',
  'extern',
  'false',
  'finally',
  'fixed',
  'float',
  'for',
  'foreach',
  'goto',
  'if',
  'implicit',
  'in',
  'int',
  'interface',
  'internal',
  'is',
  'lock',
  'long',
  'namespace',
  'new',
  'null',
  'object',
  'operator',
  'out',
  'override',
  'params',
  'private',
  'protected',
  'public',
  'readonly',
  'ref',
  'return',
  'sbyte',
  'sealed',
  'short',
  'sizeof',
  'stackalloc',
  'static',
  'string',
  'struct',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'uint',
  'ulong',
  'unchecked',
  'unsafe',
  'ushort',
  'using',
  'virtual',
  'void',
  'volatile',
  'while',
])

const NAMING: NamingRules = { language: 'csharp', convention: 'PascalCase', reserved: RESERVED, escape: (name) => `@${name}` }

const isNumber = (type: TypeRef) => type.kind === 'primitive' && ['integer', 'float', 'decimal'].includes(type.name)
const isPrimitive = (type: TypeRef, ...names: string[]) => type.kind === 'primitive' && names.includes(type.name)

function operand(code: string): string {
  return /^[\w.()"?[\]]+$/.test(code) && !code.includes(' ') ? code : `(${code})`
}

/** DateTime or DateTimeOffset: the one the C# models declare, DateTime otherwise. */
function dateTimeType(schema: ModelSchema): string {
  if (schema.origin?.language === 'csharp') {
    for (const model of schema.models)
      for (const field of model.fields)
        if (isPrimitive(field.type, 'datetime') && field.originalType?.startsWith('DateTimeOffset')) return 'DateTimeOffset'
  }
  return 'DateTime'
}

class CSharpWriter {
  readonly plan: Plan
  readonly settings: GenerateSettings
  readonly emitter: Emitter
  readonly usings = new Set<string>()
  readonly helpers = new Map<string, { key: string; code: string }>()
  readonly sourceDateTime: string
  readonly targetDateTime: string
  /** AutoMapper expressions are expression trees: no `?.`, no patterns, no throw */
  readonly expressionTree: boolean

  constructor(plan: Plan, settings: GenerateSettings, expressionTree = false) {
    this.plan = plan
    this.settings = settings
    this.expressionTree = expressionTree
    this.sourceDateTime = dateTimeType(plan.source)
    this.targetDateTime = dateTimeType(plan.target)
    this.emitter = new Emitter(this.syntax(), (field, _owner, side) => this.name(field, side))
  }

  name(field: FieldDef, side: 'source' | 'target'): string {
    return fieldName(field, side === 'source' ? this.plan.source : this.plan.target, NAMING, this.settings.naming)
  }

  enumMember(enumDef: EnumDef, name: string): string {
    return `${typeName(enumDef.name)}.${isValidIdentifier(name) && !(enumDef.kind === 'literals' && /^[a-z]/.test(name)) ? name : toPascalCase(name) || 'Value'}`
  }

  methodName(mapper: MapperPlan): string {
    return `To${typeName(mapper.target.name)}`
  }

  literal(value: Literal, type: TypeRef): string {
    if (value === null) return 'null'
    if (type.kind === 'enum' && typeof value === 'string') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef) return this.enumMember(enumDef, value)
    }
    if (typeof value === 'number') {
      if (isPrimitive(type, 'decimal')) return `${value}m`
      if (isPrimitive(type, 'float')) return Number.isInteger(value) ? `${value}.0` : String(value)
      if (type.kind === 'primitive' && type.name === 'integer' && type.bits === 64) return `${value}L`
      return String(value)
    }
    if (typeof value === 'boolean') return String(value)
    if (isPrimitive(type, 'datetime')) {
      this.usings.add('System.Globalization')
      return `${this.targetDateTime}.Parse(${quote(value)}, CultureInfo.InvariantCulture)`
    }
    return quote(value)
  }

  private invariant(): string {
    this.usings.add('System.Globalization')
    return 'CultureInfo.InvariantCulture'
  }

  convert(expr: string, from: TypeRef, to: TypeRef): string {
    if (isNumber(from) && isNumber(to) && from.kind === 'primitive' && to.kind === 'primitive') {
      if (to.name === 'decimal') return from.name === 'decimal' ? expr : `(decimal)${operand(expr)}`
      if (to.name === 'float') return from.name === 'float' ? expr : `(double)${operand(expr)}`
      if (from.name !== 'integer') return to.bits === 32 ? `(int)${operand(expr)}` : `(long)${operand(expr)}`
      if (to.bits === 32 && from.bits !== 32) return `checked((int)${operand(expr)})`
      return expr
    }
    if (isPrimitive(to, 'string')) {
      if (isPrimitive(from, 'string')) return expr
      if (isPrimitive(from, 'datetime', 'date', 'time')) return `${operand(expr)}.ToString("O", ${this.invariant()})`
      if (isNumber(from)) return `${operand(expr)}.ToString(${this.invariant()})`
      return `${operand(expr)}.ToString()`
    }
    if (isPrimitive(from, 'string', 'any')) {
      const text = isPrimitive(from, 'any') ? `${operand(expr)}.ToString()!` : expr
      if (to.kind === 'primitive') {
        switch (to.name) {
          case 'integer':
            return `${to.bits === 32 ? 'int' : 'long'}.Parse(${text}, ${this.invariant()})`
          case 'float':
            return `double.Parse(${text}, ${this.invariant()})`
          case 'decimal':
            return `decimal.Parse(${text}, ${this.invariant()})`
          case 'datetime':
            return `${this.targetDateTime}.Parse(${text}, ${this.invariant()})`
          case 'date':
            return `DateOnly.Parse(${text}, ${this.invariant()})`
          case 'time':
            return `TimeOnly.Parse(${text}, ${this.invariant()})`
          case 'duration':
            return `TimeSpan.Parse(${text}, ${this.invariant()})`
          case 'uuid':
            return `Guid.Parse(${text})`
        }
      }
      if (to.kind === 'enum') return `Enum.Parse<${typeName(to.name)}>(${text})`
    }
    if (isPrimitive(from, 'date') && isPrimitive(to, 'datetime')) return `${operand(expr)}.ToDateTime(TimeOnly.MinValue)`
    if (isPrimitive(from, 'datetime') && isPrimitive(to, 'date'))
      return `DateOnly.FromDateTime(${this.sourceDateTime === 'DateTimeOffset' ? `${operand(expr)}.UtcDateTime` : expr})`
    if (isPrimitive(from, 'datetime') && isPrimitive(to, 'datetime') && this.sourceDateTime !== this.targetDateTime) {
      return this.targetDateTime === 'DateTime' ? `${operand(expr)}.UtcDateTime` : `new DateTimeOffset(${expr})`
    }
    if (isPrimitive(from, 'boolean') && isPrimitive(to, 'integer')) return `${operand(expr)} ? 1 : 0`
    return expr
  }

  private enumHelper(node: Extract<Value, { k: 'enumMap' }>): string {
    const source = node.source
    const target = typeName(node.target.name)
    const base = `To${target}`
    const key = JSON.stringify([node.pairs, node.fallback, source?.name])
    let name = base
    for (let n = 2; this.helpers.has(name) && this.helpers.get(name)!.key !== key; n++) name = `${base}${n}`
    if (!this.helpers.has(name)) {
      const arms = node.pairs.map(
        (pair) => `${source ? this.enumMember(source, pair.from) : quote(pair.from)} => ${this.enumMember(node.target, pair.to)},`,
      )
      arms.push(
        node.fallback !== undefined
          ? `_ => ${this.enumMember(node.target, node.fallback)},`
          : '_ => throw new ArgumentOutOfRangeException(nameof(value), value, null),',
      )
      const parameter = source ? typeName(source.name) : 'string'
      const code = `    private static ${target} ${name}(${parameter} value) => value switch\n    {\n${indent(arms.join('\n'), 8)}\n    };`
      this.helpers.set(name, { key, code })
    }
    return name
  }

  syntax(): Syntax {
    const syntax: Syntax = {
      access: (base, _step, name) => `${base}.${name}`,
      literal: (value, type) => this.literal(value, type),
      convert: (expr, from, to) => this.convert(expr, from, to),
      concat: (parts, separator) => {
        if (parts.every((part) => !/["{}\\]/.test(part)))
          return `$${quote(parts.map((part) => `{${part}}`).join(separator.replace(/[{}]/g, (char) => char + char)))}`
        return `string.Concat(${parts.flatMap((part, index) => (index === 0 ? [part] : [quote(separator), part])).join(', ')})`
      },
      split: (expr, separator, part) => {
        const sep = quote(separator)
        if (part === 0) return `${operand(expr)}.Split(${sep})[0]`
        if (part === 'last') return `${operand(expr)}.Split(${sep})[^1]`
        if (part === 'rest')
          return `${operand(expr)}.Contains(${sep}) ? ${operand(expr)}[(${operand(expr)}.IndexOf(${sep}, StringComparison.Ordinal) + ${separator.length})..] : ""`
        return `${operand(expr)}.Split(${sep})[${part}]`
      },
      boolean: (expr, trueValues, from) => {
        const enumDef = from.kind === 'enum' ? findEnum(this.plan.source, from.name) : undefined
        const values = trueValues.map((value) => (enumDef ? this.enumMember(enumDef, value) : quote(value)))
        return values.length === 1 || this.expressionTree
          ? values.map((value) => `${expr} == ${value}`).join(' || ')
          : `${expr} is ${values.join(' or ')}`
      },
      enumMap: (expr, node) => `${this.enumHelper({ ...node, type: { kind: 'enum', name: node.target.name }, nullable: false })}(${expr})`,
      epoch: (expr, unit, toDate, from) => {
        if (toDate) {
          const whole = isPrimitive(from, 'float') ? `(long)${operand(expr)}` : expr
          const offset = `DateTimeOffset.FromUnixTime${unit === 'seconds' ? 'Seconds' : 'Milliseconds'}(${whole})`
          return this.targetDateTime === 'DateTime' ? `${offset}.UtcDateTime` : offset
        }
        const offset = this.sourceDateTime === 'DateTime' ? `new DateTimeOffset(${expr})` : expr
        return `${operand(offset)}.ToUnixTime${unit === 'seconds' ? 'Seconds' : 'Milliseconds'}()`
      },
      arithmetic: (expr, operator, value, type) =>
        `${operand(expr)} ${operator} ${isPrimitive(type, 'decimal') ? `${value}m` : isPrimitive(type, 'float') && Number.isInteger(value) ? `${value}.0` : value}`,
      mapperCall: (mapper, expr) => `${operand(expr)}.${this.methodName(mapper)}()`,
      list: (expr, item, element, isMap, elementIsItem, container) => {
        this.usings.add('System.Linq')
        if (isMap)
          return `${operand(expr)}.ToDictionary(entry => entry.Key, entry => ${elementIsItem ? 'entry.Value' : element.split(item).join('entry.Value')})`
        const collect = /Set$/.test(container ?? '')
          ? 'ToHashSet()'
          : container?.endsWith('[]') || container === ''
            ? 'ToArray()'
            : 'ToList()'
        return elementIsItem ? `${operand(expr)}.${collect}` : `${operand(expr)}.Select(${item} => ${element}).${collect}`
      },
      coalesce: (expr, fallback) => `${expr} ?? ${fallback}`,
      nullSafe: (expr, build, context) => {
        if (this.expressionTree) return build(expr)
        // A call or member read on the value: `x?.ToAddress()`
        const marker = '\u0000'
        const built = build(marker)
        if (built.startsWith(`${marker}.`) && !built.slice(1).includes(marker)) return `${operand(expr)}?${built.slice(1)}`
        return `${operand(expr)} is { } ${context.variable} ? ${build(context.variable)} : null`
      },
      unwrap: (expr) =>
        this.expressionTree ? expr : `${expr} ?? throw new InvalidOperationException("A required value is missing in the source.")`,
      placeholder: (type) => this.placeholder(type),
      expression: {
        binary: (operator, left, right) => `${left} ${operator} ${right}`,
        not: (value) => `!${operand(value)}`,
        conditional: (condition, then, otherwise) => `${condition} ? ${then} : ${otherwise}`,
        call: (name, args) => {
          const [a, b, c] = args
          switch (name) {
            case 'upper':
              return `${operand(a)}.ToUpperInvariant()`
            case 'lower':
              return `${operand(a)}.ToLowerInvariant()`
            case 'trim':
              return `${operand(a)}.Trim()`
            case 'length':
              return `${operand(a)}.Length`
            case 'concat':
              return `string.Concat(${args.join(', ')})`
            case 'substring':
              return c === undefined ? `${operand(a)}.Substring(${b})` : `${operand(a)}.Substring(${b}, ${c})`
            case 'replace':
              return `${operand(a)}.Replace(${b}, ${c})`
            case 'round':
            case 'floor':
            case 'abs':
            case 'min':
            case 'max':
              return `Math.${name.charAt(0).toUpperCase()}${name.slice(1)}(${args.join(', ')})`
            case 'ceil':
              return `Math.Ceiling(${a})`
            case 'toString':
              return `${operand(a)}.ToString()`
            case 'toNumber':
              return `double.Parse(${a}, ${this.invariant()})`
          }
        },
      },
    }
    if (!this.expressionTree) syntax.safeAccess = (base, _step, name) => `${base}?.${name}`
    return syntax
  }

  placeholder(type: TypeRef): string {
    if (type.kind === 'enum') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef?.values[0]) return this.enumMember(enumDef, enumDef.values[0].name)
    }
    if (type.kind === 'primitive') {
      switch (type.name) {
        case 'string':
          return '""'
        case 'integer':
          return '0'
        case 'float':
          return '0.0'
        case 'decimal':
          return '0m'
        case 'boolean':
          return 'false'
        case 'datetime':
          return `${this.targetDateTime}.MinValue`
        case 'uuid':
          return 'Guid.Empty'
      }
    }
    return type.kind === 'array' || type.kind === 'map' || type.kind === 'model' ? 'new()' : 'default!'
  }

  className(): string {
    return `${typeName(this.plan.root.source.name)}Mappings`
  }

  mapperMethod(mapper: MapperPlan): string {
    const roots = { source: 'source', item: 'item', depth: 0, lists: 0 }
    const values = mapper.assignments.map((assignment) => ({ assignment, code: this.emitter.assignment(assignment, roots) }))
    const comment = (assignment: Assignment) =>
      assignment.missing ? [`// TODO: no value for "${assignment.field.name}" in the mapping`] : []
    const target = typeName(mapper.target.name)
    let body: string
    if (mapper.target.construction === 'positional') {
      const args = values.flatMap(({ assignment, code }) => [...comment(assignment), `${code ?? 'default'},`])
      if (args.length > 0) args[args.length - 1] = args[args.length - 1].replace(/,$/, '')
      body = `return new ${target}(\n${indent(args.join('\n'), 4)}\n);`
    } else {
      const lines = values
        .filter(({ code }) => code !== null)
        .flatMap(({ assignment, code }) => [...comment(assignment), `${this.name(assignment.field, 'target')} = ${code},`])
      body = lines.length > 0 ? `return new ${target}\n{\n${indent(lines.join('\n'), 4)}\n};` : `return new ${target}();`
    }
    return `    public static ${target} ${this.methodName(mapper)}(this ${typeName(mapper.source.name)} source)\n    {\n        ArgumentNullException.ThrowIfNull(source);\n${indent(body, 8)}\n    }`
  }

  namespace(): string {
    return optionValue(cSharpGenerator, this.plan, this.settings, 'namespace')
  }
}

function header(usings: Set<string>, namespace: string): string {
  // System namespaces first, as .NET code usually orders them
  const order = (item: string) => (item === 'System' || item.startsWith('System.') ? `0${item}` : `1${item}`)
  const lines = [...usings].sort((a, b) => order(a).localeCompare(order(b))).map((item) => `using ${item};`)
  return [lines.join('\n'), namespace ? `namespace ${namespace};` : ''].filter((part) => part !== '').join('\n\n')
}

function generateManual(plan: Plan, settings: GenerateSettings): GeneratedCode {
  const writer = new CSharpWriter(plan, settings)
  writer.usings.add('System')
  const methods = plan.mappers.map((mapper) => writer.mapperMethod(mapper))
  const helpers = [...writer.helpers.values()].map((helper) => helper.code)
  const name = writer.className()
  const code = `${header(writer.usings, writer.namespace())}\n\npublic static class ${name}\n{\n${[...methods, ...helpers].join('\n\n')}\n}\n`
  return { files: [{ name: `${name}.cs`, code }], notes: writer.emitter.notes }
}

/** AutoMapper: one profile with a map per pair of models; `ForMember` only where conventions do not
 * find the value by themselves. */
function generateAutoMapper(plan: Plan, settings: GenerateSettings): GeneratedCode {
  const writer = new CSharpWriter(plan, settings, true)
  writer.usings.add('AutoMapper')
  const maps: string[] = []
  const enumMaps = new Map<string, string>()
  for (const mapper of plan.mappers) {
    const members: string[] = []
    for (const assignment of mapper.assignments) {
      const target = writer.name(assignment.field, 'target')
      const value = assignment.value
      if (!value) {
        if (assignment.missing) writer.emitter.notes.push({ code: 'missingValue', params: { field: assignment.field.name } })
        members.push(
          `.ForMember(dest => dest.${target}, opt => opt.Ignore())${assignment.missing ? ' // TODO: no value in the mapping' : ''}`,
        )
        continue
      }
      const inner = value.k === 'coalesce' ? value.value : value
      const fallback =
        value.k === 'coalesce' && value.fallback.k === 'literal'
          ? writer.emitter.value(value.fallback, { source: 'src', item: 'item', depth: 0, lists: 0 })
          : null
      const base = inner.k === 'convert' || inner.k === 'mapper' || inner.k === 'list' || inner.k === 'enumMap' ? inner.value : inner
      // Same name: AutoMapper finds it, converts it and maps nested objects, lists and enums (by their own maps)
      const conventional =
        base.k === 'path' &&
        base.steps.length === 1 &&
        writer.name(base.steps[0].field, 'source') === target &&
        (inner.k !== 'enumMap' || inner.source !== undefined)
      if (inner.k === 'enumMap') {
        const key = `${inner.source?.name ?? 'string'}->${inner.target.name}`
        if (!enumMaps.has(key) && inner.source) {
          const call = writer.emitter.syntax.enumMap('value', inner, inner.value.type)
          enumMaps.set(key, `CreateMap<${typeName(inner.source.name)}, ${typeName(inner.target.name)}>().ConvertUsing(value => ${call});`)
        }
      }
      if (conventional && !fallback) continue
      const expression =
        (base.k === 'path' || base.k === 'self') &&
        (inner.k === 'mapper' || inner.k === 'list' || inner.k === 'enumMap' || inner.k === 'convert')
          ? writer.emitter.value(base, { source: 'src', item: 'item', depth: 0, lists: 0 })
          : writer.emitter.value(inner, { source: 'src', item: 'item', depth: 0, lists: 0 })
      const options = conventional ? [] : [`opt.MapFrom(src => ${expression})`]
      if (fallback) options.push(`opt.NullSubstitute(${fallback})`)
      members.push(
        `.ForMember(dest => dest.${target}, opt => ${options.length === 1 ? options[0] : `{ ${options.map((item) => `${item};`).join(' ')} }`})`,
      )
    }
    const create = `CreateMap<${typeName(mapper.source.name)}, ${typeName(mapper.target.name)}>()`
    maps.push(members.length > 0 ? `${create}\n${indent(members.join('\n'), 4)};` : `${create};`)
  }
  const helpers = [...writer.helpers.values()].map((helper) => helper.code)
  const name = `${typeName(plan.root.source.name)}Profile`
  const constructor = `    public ${name}()\n    {\n${indent([...maps, ...enumMaps.values()].join('\n\n'), 8)}\n    }`
  writer.usings.add('System')
  const code = `${header(writer.usings, writer.namespace())}\n\npublic class ${name} : Profile\n{\n${[constructor, ...helpers].join('\n\n')}\n}\n`
  return { files: [{ name: `${name}.cs`, code }], notes: writer.emitter.notes }
}

export const cSharpGenerator: CodeGenerator = {
  id: 'csharp',
  label: 'C#',
  editorLanguage: 'csharp',
  modes: ['manual', 'automapper'],
  options: [{ id: 'namespace', kind: 'text', choices: [''] }],
  defaults: (plan) => {
    const namespace = plan.target.origin?.language === 'csharp' ? plan.root.target.namespace : undefined
    return namespace ? { namespace } : ({} as Record<string, string>)
  },
  generate: (plan, settings) => (settings.mode === 'automapper' ? generateAutoMapper(plan, settings) : generateManual(plan, settings)),
}
