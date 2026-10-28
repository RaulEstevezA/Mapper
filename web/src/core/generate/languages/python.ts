import { toScreamingSnakeCase, toSnakeCase } from '../../model/naming.ts'
import { findEnum, type EnumDef, type FieldDef, type Literal, type TypeRef } from '../../model/schema.ts'
import { Emitter, indent, type Syntax } from '../emitter.ts'
import { fieldName, isValidIdentifier, typeName, type NamingRules } from '../naming.ts'
import { allValues, isDocumentSchema, planForPlainObjects, type MapperPlan, type Plan, type Value } from '../plan.ts'
import { optionValue, type CodeGenerator, type GeneratedCode, type GenerateSettings } from '../types.ts'

const RESERVED = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
])

const isNumber = (type: TypeRef) => type.kind === 'primitive' && ['integer', 'float', 'decimal'].includes(type.name)
const isPrimitive = (type: TypeRef, ...names: string[]) => type.kind === 'primitive' && names.includes(type.name)

function quote(text: string): string {
  return JSON.stringify(text)
}

/** Parenthesizes an expression that is not a simple operand. */
function operand(code: string): string {
  return /^[\w.[\]"()]+$/.test(code) && !code.includes(' ') ? code : `(${code})`
}

class PythonWriter {
  readonly plan: Plan
  readonly settings: GenerateSettings
  readonly sourceDict: boolean
  readonly targetDict: boolean
  readonly emitter: Emitter
  readonly naming: NamingRules
  readonly imports = new Map<string, Set<string>>()
  readonly helpers = new Map<string, { key: string; code: string }>()

  constructor(plan: Plan, settings: GenerateSettings, sourceDict: boolean, targetDict: boolean) {
    this.plan = plan
    this.settings = settings
    this.sourceDict = sourceDict
    this.targetDict = targetDict
    // Dictionaries keep the document's keys; classes use Python names
    this.naming = { language: 'python', convention: 'snake_case', reserved: RESERVED, escape: (name) => `${name}_` }
    this.emitter = new Emitter(this.syntax(), (field, _owner, side) => this.name(field, side))
  }

  private name(field: FieldDef, side: 'source' | 'target'): string {
    const dict = side === 'source' ? this.sourceDict : this.targetDict
    if (dict) return field.name
    return fieldName(field, side === 'source' ? this.plan.source : this.plan.target, this.naming, this.settings.naming)
  }

  private use(module: string, name: string) {
    this.imports.set(module, new Set([...(this.imports.get(module) ?? []), name]))
  }

  mapperName(mapper: MapperPlan): string {
    return `map_${toSnakeCase(mapper.source.name)}_to_${toSnakeCase(mapper.target.name)}`
  }

  private enumMember(enumDef: EnumDef, name: string, dict: boolean): string {
    const value = enumDef.values.find((item) => item.name === name)
    // In a document, or for a set of literals, the value itself is written
    if (dict || enumDef.kind === 'literals')
      return typeof value?.value === 'number' ? String(value.value) : quote(String(value?.value ?? name))
    const member = isValidIdentifier(name) ? name : toScreamingSnakeCase(name)
    return `${typeName(enumDef.name)}.${member}`
  }

  private literal(value: Literal, type: TypeRef): string {
    if (value === null) return 'None'
    if (typeof value === 'boolean') return value ? 'True' : 'False'
    if (type.kind === 'enum' && typeof value === 'string') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef) return this.enumMember(enumDef, value, this.targetDict)
    }
    if (typeof value === 'number') {
      if (isPrimitive(type, 'decimal')) {
        this.use('decimal', 'Decimal')
        return `Decimal(${quote(String(value))})`
      }
      return isPrimitive(type, 'float') && Number.isInteger(value) ? `${value}.0` : String(value)
    }
    if (isPrimitive(type, 'datetime') && !this.targetDict) {
      this.use('datetime', 'datetime')
      return `datetime.fromisoformat(${quote(value)})`
    }
    return quote(value)
  }

  private enumHelper(node: Extract<Value, { k: 'enumMap' }>): string {
    const source = node.source
    const base = `_map_${toSnakeCase(source?.name ?? 'value')}_to_${toSnakeCase(node.target.name)}`
    const key = JSON.stringify([node.pairs, node.fallback, source?.name])
    let name = base
    for (let n = 2; this.helpers.has(name) && this.helpers.get(name)!.key !== key; n++) name = `${base}_${n}`
    if (!this.helpers.has(name)) {
      const table = `${name.toUpperCase().replace(/^_MAP_/, '_')}`
      const entries = node.pairs.map((pair) => {
        const from = source ? this.enumMember(source, pair.from, this.sourceDict) : quote(pair.from)
        return `    ${from}: ${this.enumMember(node.target, pair.to, this.targetDict)},`
      })
      const lookup =
        node.fallback !== undefined
          ? `${table}.get(value, ${this.enumMember(node.target, node.fallback, this.targetDict)})`
          : `${table}[value]`
      const sourceType = source && !this.sourceDict ? typeName(source.name) : 'str'
      const targetType = this.targetDict ? 'str' : typeName(node.target.name)
      const code = `${table} = {\n${entries.join('\n')}\n}\n\n\ndef ${name}(value: ${sourceType}) -> ${targetType}:\n    return ${lookup}`
      this.helpers.set(name, { key, code })
    }
    return name
  }

  syntax(): Syntax {
    const access = (base: string, name: string, nullable: boolean, dict: boolean) => {
      if (!dict) return `${base}.${name}`
      return nullable ? `${base}.get(${quote(name)})` : `${base}[${quote(name)}]`
    }
    return {
      access: (base, step, name) => access(base, name, step.nullable, this.sourceDict),
      literal: (value, type) => this.literal(value, type),
      convert: (expr, from, to) => this.convert(expr, from, to),
      concat: (parts, separator) => {
        const simple = parts.every((part) => !/["'\\{}]/.test(part))
        if (simple) return `f${quote(parts.map((part) => `{${part}}`).join(separator.replace(/[{}]/g, (char) => char + char)))}`
        return `${quote(separator)}.join([${parts.join(', ')}])`
      },
      split: (expr, separator, part) => {
        const sep = quote(separator)
        if (part === 0) return `${operand(expr)}.split(${sep})[0]`
        if (part === 'rest') return `${operand(expr)}.partition(${sep})[2]`
        if (part === 'last') return `${operand(expr)}.rsplit(${sep}, 1)[-1]`
        return `(${operand(expr)}.split(${sep}) + [""] * ${part + 1})[${part}]`
      },
      boolean: (expr, trueValues, from) => {
        const enumDef = from.kind === 'enum' ? findEnum(this.plan.source, from.name) : undefined
        const values = trueValues.map((value) => (enumDef ? this.enumMember(enumDef, value, this.sourceDict) : quote(value)))
        return values.length === 1 ? `${expr} == ${values[0]}` : `${expr} in (${values.join(', ')})`
      },
      enumMap: (expr, node) => `${this.enumHelper({ ...node, type: { kind: 'enum', name: node.target.name }, nullable: false })}(${expr})`,
      epoch: (expr, unit, toDate) => {
        if (toDate) {
          this.use('datetime', 'datetime')
          this.use('datetime', 'timezone')
          return `datetime.fromtimestamp(${unit === 'seconds' ? expr : `${operand(expr)} / 1000`}, tz=timezone.utc)`
        }
        return unit === 'seconds' ? `int(${operand(expr)}.timestamp())` : `int(${operand(expr)}.timestamp() * 1000)`
      },
      arithmetic: (expr, operator, value) => `${operand(expr)} ${operator} ${value}`,
      mapperCall: (mapper, expr) => `${this.mapperName(mapper)}(${expr})`,
      list: (expr, item, element, isMap, elementIsItem) => {
        if (isMap) return elementIsItem ? `dict(${expr})` : `{key: ${element} for key, ${item} in ${operand(expr)}.items()}`
        return elementIsItem ? `list(${expr})` : `[${element} for ${item} in ${expr}]`
      },
      coalesce: (expr, fallback) => `${operand(expr)} if ${operand(expr)} is not None else ${fallback}`,
      nullSafe: (expr, build) => `${build(expr)} if ${operand(expr)} is not None else None`,
      unwrap: (expr) => expr,
      placeholder: (type) => this.placeholder(type),
      expression: {
        binary: (operator, left, right) => {
          if (operator === '&&') return `${left} and ${right}`
          if (operator === '||') return `${left} or ${right}`
          if (operator === '??') return `${operand(left)} if ${operand(left)} is not None else ${right}`
          return `${left} ${operator} ${right}`
        },
        not: (value) => `not ${operand(value)}`,
        conditional: (condition, then, otherwise) => `${then} if ${condition} else ${otherwise}`,
        call: (name, args) => {
          const [a, b, c] = args
          switch (name) {
            case 'upper':
            case 'lower':
              return `${operand(a)}.${name}()`
            case 'trim':
              return `${operand(a)}.strip()`
            case 'length':
              return `len(${a})`
            case 'concat':
              return `"".join([${args.map((arg) => `str(${arg})`).join(', ')}])`
            case 'substring':
              return c === undefined ? `${operand(a)}[${b}:]` : `${operand(a)}[${b}:${operand(b)} + ${operand(c)}]`
            case 'replace':
              return `${operand(a)}.replace(${b}, ${c})`
            case 'round':
            case 'abs':
            case 'min':
            case 'max':
              return `${name}(${args.join(', ')})`
            case 'floor':
            case 'ceil':
              this.use('math', name)
              return `${name}(${a})`
            case 'toString':
              return `str(${a})`
            case 'toNumber':
              return `float(${a})`
          }
        },
      },
    }
  }

  private convert(expr: string, from: TypeRef, to: TypeRef): string {
    if (isNumber(from) && isNumber(to)) {
      if (isPrimitive(to, 'integer') && !isPrimitive(from, 'integer')) return `int(${expr})`
      if (isPrimitive(to, 'decimal') && !isPrimitive(from, 'decimal')) {
        this.use('decimal', 'Decimal')
        return isPrimitive(from, 'float') ? `Decimal(str(${expr}))` : `Decimal(${expr})`
      }
      if (isPrimitive(to, 'float') && isPrimitive(from, 'decimal')) return `float(${expr})`
      return expr
    }
    if (isPrimitive(to, 'string')) {
      if (isPrimitive(from, 'datetime', 'date', 'time')) return `${operand(expr)}.isoformat()`
      if (from.kind === 'enum') {
        const enumDef = findEnum(this.plan.source, from.name)
        return this.sourceDict || enumDef?.kind === 'literals' ? expr : `${operand(expr)}.value`
      }
      if (isPrimitive(from, 'string')) return expr
      return `str(${expr})`
    }
    if (isPrimitive(from, 'string', 'any')) {
      if (isPrimitive(to, 'integer')) return `int(${expr})`
      if (isPrimitive(to, 'float')) return `float(${expr})`
      if (isPrimitive(to, 'decimal')) {
        this.use('decimal', 'Decimal')
        return `Decimal(${expr})`
      }
      if (isPrimitive(to, 'datetime')) {
        this.use('datetime', 'datetime')
        return `datetime.fromisoformat(${expr})`
      }
      if (isPrimitive(to, 'date')) {
        this.use('datetime', 'date')
        return `date.fromisoformat(${expr})`
      }
      if (isPrimitive(to, 'time')) {
        this.use('datetime', 'time')
        return `time.fromisoformat(${expr})`
      }
      if (isPrimitive(to, 'uuid')) {
        this.use('uuid', 'UUID')
        return `UUID(${expr})`
      }
      if (to.kind === 'enum') {
        const enumDef = findEnum(this.plan.target, to.name)
        return this.targetDict || enumDef?.kind === 'literals' ? expr : `${typeName(to.name)}(${expr})`
      }
    }
    if (isPrimitive(from, 'date') && isPrimitive(to, 'datetime')) {
      this.use('datetime', 'datetime')
      return `datetime.combine(${expr}, datetime.min.time())`
    }
    if (isPrimitive(from, 'datetime') && isPrimitive(to, 'date')) return `${operand(expr)}.date()`
    if (isPrimitive(from, 'boolean') && isPrimitive(to, 'integer')) return `int(${expr})`
    return expr
  }

  private placeholder(type: TypeRef): string {
    if (type.kind === 'array') return '[]'
    if (type.kind === 'map') return '{}'
    if (type.kind === 'enum') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef?.values[0]) return this.enumMember(enumDef, enumDef.values[0].name, this.targetDict)
    }
    if (type.kind === 'primitive') {
      switch (type.name) {
        case 'string':
        case 'uuid':
          return '""'
        case 'integer':
          return '0'
        case 'float':
          return '0.0'
        case 'decimal':
          this.use('decimal', 'Decimal')
          return 'Decimal("0")'
        case 'boolean':
          return 'False'
        case 'datetime':
          this.use('datetime', 'datetime')
          this.use('datetime', 'timezone')
          return 'datetime.fromtimestamp(0, tz=timezone.utc)'
      }
    }
    return 'None'
  }

  private targetKey(field: FieldDef): string {
    if (this.targetDict) return field.name
    // Pydantic models with an alias are built with the alias unless populate_by_name is set
    const model = this.plan.target.models.find((item) => item.fields.includes(field))
    if (model?.framework === 'pydantic' && field.serializedName && isValidIdentifier(field.serializedName)) return field.serializedName
    return this.name(field, 'target')
  }

  mapperFunction(mapper: MapperPlan): string {
    const roots = { source: 'source', item: 'item', depth: 0, lists: 0 }
    const lines: string[] = []
    for (const assignment of mapper.assignments) {
      const code = this.emitter.assignment(assignment, roots)
      if (code === null) continue
      const key = this.targetKey(assignment.field)
      if (assignment.missing) lines.push(`# TODO: no value for "${assignment.field.name}" in the mapping`)
      else if (assignment.unsafeNull) lines.push(`# TODO: the source may be missing, but "${assignment.field.name}" is required`)
      lines.push(this.targetDict ? `${quote(key)}: ${code},` : `${key}=${code},`)
    }
    const sourceType = this.sourceDict ? 'dict[str, Any]' : typeName(mapper.source.name)
    const targetType = this.targetDict ? 'dict[str, Any]' : typeName(mapper.target.name)
    if (this.sourceDict || this.targetDict) this.use('typing', 'Any')
    const body = this.targetDict ? `{\n${indent(lines.join('\n'), 8)}\n    }` : `${targetType}(\n${indent(lines.join('\n'), 8)}\n    )`
    return `def ${this.mapperName(mapper)}(source: ${sourceType}) -> ${targetType}:\n    return ${lines.length > 0 ? body : this.targetDict ? '{}' : `${targetType}()`}`
  }

  importBlock(): string {
    const standard = ['datetime', 'decimal', 'math', 'typing', 'uuid']
    const lines = standard
      .filter((module) => this.imports.has(module))
      .map((module) => `from ${module} import ${[...this.imports.get(module)!].sort().join(', ')}`)
    const models = new Set<string>()
    for (const mapper of this.plan.mappers) {
      if (!this.sourceDict) models.add(typeName(mapper.source.name))
      if (!this.targetDict) models.add(typeName(mapper.target.name))
    }
    for (const value of allValues(this.plan)) {
      if (value.k === 'enumMap') {
        if (value.source && !this.sourceDict && value.source.kind !== 'literals') models.add(typeName(value.source.name))
        if (!this.targetDict && value.target.kind !== 'literals') models.add(typeName(value.target.name))
      }
      if (value.k === 'boolean' && value.value.type.kind === 'enum' && !this.sourceDict) {
        const enumDef = findEnum(this.plan.source, value.value.type.name)
        if (enumDef && enumDef.kind !== 'literals') models.add(typeName(enumDef.name))
      }
      if ((value.k === 'literal' || value.k === 'convert') && value.type.kind === 'enum' && !this.targetDict) {
        const enumDef = findEnum(this.plan.target, value.type.name)
        if (enumDef && enumDef.kind !== 'literals') models.add(typeName(enumDef.name))
      }
    }
    const module = optionValue(pythonGenerator, this.plan, this.settings, 'modelsModule')
    if (models.size > 0) lines.push('', `from ${module} import ${[...models].sort().join(', ')}`)
    return lines.join('\n')
  }
}

function generate(original: Plan, settings: GenerateSettings): GeneratedCode {
  const sourceDict = optionValue(pythonGenerator, original, settings, 'sourceAccess') === 'dict'
  const targetDict = optionValue(pythonGenerator, original, settings, 'targetStyle') === 'dict'
  const plan = planForPlainObjects(original, sourceDict, targetDict)
  const writer = new PythonWriter(plan, settings, sourceDict, targetDict)
  const functions = plan.mappers.map((mapper) => writer.mapperFunction(mapper))
  const helpers = [...writer.helpers.values()].map((helper) => helper.code)
  const imports = writer.importBlock()
  const code = [imports, ...functions, ...helpers].filter((part) => part !== '').join('\n\n\n') + '\n'
  return { files: [{ name: 'mapper.py', code }], notes: writer.emitter.notes }
}

export const pythonGenerator: CodeGenerator = {
  id: 'python',
  label: 'Python',
  editorLanguage: 'python',
  modes: ['functions'],
  options: [
    { id: 'sourceAccess', choices: ['attribute', 'dict'] },
    { id: 'targetStyle', choices: ['constructor', 'dict'] },
    { id: 'modelsModule', kind: 'text', choices: ['models'] },
  ],
  // A JSON document arrives as a dict; a class from code is read by its attributes
  defaults: (plan) => ({
    sourceAccess: isDocumentSchema(plan.source) ? 'dict' : 'attribute',
    targetStyle: isDocumentSchema(plan.target) ? 'dict' : 'constructor',
  }),
  generate,
}
