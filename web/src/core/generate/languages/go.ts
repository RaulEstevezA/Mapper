import { toPascalCase } from '../../model/naming.ts'
import { findEnum, type EnumDef, type FieldDef, type Literal, type TypeRef } from '../../model/schema.ts'
import { Emitter, indent, quote, type Syntax } from '../emitter.ts'
import { fieldName, typeName, type NamingRules } from '../naming.ts'
import { allValues, type MapperPlan, type Plan, type Value } from '../plan.ts'
import { optionValue, type CodeGenerator, type GeneratedCode, type GenerateSettings } from '../types.ts'

const RESERVED = new Set([
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
])
const NAMING: NamingRules = {
  language: 'go',
  convention: 'PascalCase',
  reserved: RESERVED,
  escape: (name) => `${name}_`,
  initialisms: true,
}

const isPrimitive = (type: TypeRef, ...names: string[]) => type.kind === 'primitive' && names.includes(type.name)
const isNumber = (type: TypeRef) => isPrimitive(type, 'integer', 'float', 'decimal')

// Generic helpers written into the file when the mapping needs them
const HELPERS: Record<string, string> = {
  mapSlice: `func mapSlice[T, R any](items []T, mapItem func(T) R) []R {
	if items == nil {
		return nil
	}
	result := make([]R, len(items))
	for index, item := range items {
		result[index] = mapItem(item)
	}
	return result
}`,
  mapValues: `func mapValues[K comparable, T, R any](items map[K]T, mapItem func(T) R) map[K]R {
	if items == nil {
		return nil
	}
	result := make(map[K]R, len(items))
	for key, item := range items {
		result[key] = mapItem(item)
	}
	return result
}`,
  mapPointer: `func mapPointer[T, R any](value *T, mapValue func(T) R) *R {
	if value == nil {
		return nil
	}
	result := mapValue(*value)
	return &result
}`,
  valueOr: `func valueOr[T any](value *T, fallback T) T {
	if value == nil {
		return fallback
	}
	return *value
}`,
  pointerTo: `func pointerTo[T any](value T) *T {
	return &value
}`,
}

class GoWriter {
  readonly plan: Plan
  readonly settings: GenerateSettings
  readonly emitter: Emitter
  readonly imports = new Set<string>()
  readonly helpers = new Set<string>()
  readonly enumHelpers = new Map<string, { key: string; code: string }>()
  /** Some conversion may fail: mappers collect errors in `errs` */
  readonly fallible: boolean

  constructor(plan: Plan, settings: GenerateSettings) {
    this.plan = plan
    this.settings = settings
    this.fallible = allValues(plan).some(
      (value) =>
        value.k === 'convert' &&
        isPrimitive(value.value.type, 'string', 'any') &&
        !isPrimitive(value.type, 'string') &&
        value.type.kind !== 'enum',
    )
    this.emitter = new Emitter(this.syntax(), (field, _owner, side) => this.name(field, side))
  }

  name(field: FieldDef, side: 'source' | 'target'): string {
    return fieldName(field, side === 'source' ? this.plan.source : this.plan.target, NAMING, this.settings.naming)
  }

  /** Go type of a value, for the parameters of the helper closures. */
  goType(type: TypeRef, side: 'source' | 'target'): string {
    void side
    switch (type.kind) {
      case 'primitive':
        switch (type.name) {
          case 'string':
          case 'uuid':
            return 'string'
          case 'integer':
            return type.bits === 32 ? 'int32' : type.bits === 16 ? 'int16' : type.bits === 8 ? 'int8' : 'int64'
          case 'float':
          case 'decimal':
            return type.bits === 32 ? 'float32' : 'float64'
          case 'boolean':
            return 'bool'
          case 'datetime':
          case 'date':
            this.imports.add('time')
            return 'time.Time'
          case 'duration':
            this.imports.add('time')
            return 'time.Duration'
          case 'binary':
            return '[]byte'
          default:
            return 'any'
        }
      case 'array':
        return `[]${this.goType(type.items, side)}`
      case 'map':
        return `map[string]${this.goType(type.value, side)}`
      case 'model':
      case 'enum':
        return typeName(type.name)
      case 'unknown':
        return 'any'
    }
  }

  constant(enumDef: EnumDef, name: string): string {
    // Go constants usually carry the type's name: StatusActive
    const schema = this.plan.target.enums.includes(enumDef) ? this.plan.target : this.plan.source
    if (schema.origin?.language === 'go') return name
    return `${typeName(enumDef.name)}${toPascalCase(name)}`
  }

  functionName(mapper: MapperPlan, exported: boolean): string {
    const name = `${typeName(mapper.source.name)}To${typeName(mapper.target.name)}`
    return exported ? `Map${name}` : `map${name}`
  }

  literal(value: Literal, type: TypeRef): string {
    if (value === null) return 'nil'
    if (type.kind === 'enum' && typeof value === 'string') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef) return this.constant(enumDef, value)
    }
    if (typeof value === 'number') return isPrimitive(type, 'float', 'decimal') && Number.isInteger(value) ? `${value}.0` : String(value)
    if (typeof value === 'boolean') return String(value)
    return quote(value)
  }

  private errsArgument(): string {
    return this.fallible ? ', errs' : ''
  }

  convert(expr: string, from: TypeRef, to: TypeRef): string {
    if (isNumber(from) && isNumber(to))
      return this.goType(from, 'source') === this.goType(to, 'target') ? expr : `${this.goType(to, 'target')}(${expr})`
    if (isPrimitive(to, 'string')) {
      if (isPrimitive(from, 'string', 'uuid')) return expr
      if (from.kind === 'enum') return `string(${expr})`
      if (isPrimitive(from, 'datetime')) return `${expr}.Format(time.RFC3339)`
      if (isPrimitive(from, 'date')) return `${expr}.Format(time.DateOnly)`
      this.imports.add('fmt')
      return `fmt.Sprint(${expr})`
    }
    if (isPrimitive(from, 'string')) {
      const target = this.goType(to, 'target')
      if (isPrimitive(to, 'integer')) return `parseInt[${target}](${expr}${this.errsArgument()})`
      if (isPrimitive(to, 'float', 'decimal')) return `parseFloat[${target}](${expr}${this.errsArgument()})`
      if (isPrimitive(to, 'datetime')) return `parseTime(${expr}, time.RFC3339${this.errsArgument()})`
      if (isPrimitive(to, 'date')) return `parseTime(${expr}, time.DateOnly${this.errsArgument()})`
      if (to.kind === 'enum') return `${typeName(to.name)}(${expr})`
    }
    if (isPrimitive(from, 'date') && isPrimitive(to, 'datetime')) return expr
    if (isPrimitive(from, 'datetime') && isPrimitive(to, 'date')) return `${expr}.Truncate(24 * time.Hour)`
    return expr
  }

  private enumHelper(node: Extract<Value, { k: 'enumMap' }>): string {
    const source = node.source
    const target = typeName(node.target.name)
    const base = `to${target}`
    const key = JSON.stringify([node.pairs, node.fallback, source?.name])
    let name = base
    for (let n = 2; this.enumHelpers.has(name) && this.enumHelpers.get(name)!.key !== key; n++) name = `${base}${n}`
    if (!this.enumHelpers.has(name)) {
      const cases = node.pairs.map(
        (pair) => `case ${source ? this.constant(source, pair.from) : quote(pair.from)}:\n\treturn ${this.constant(node.target, pair.to)}`,
      )
      let fallback: string
      if (node.fallback !== undefined) fallback = `default:\n\treturn ${this.constant(node.target, node.fallback)}`
      else {
        this.imports.add('fmt')
        fallback = `default:\n\tpanic(fmt.Sprintf("unexpected ${source?.name ?? 'value'}: %v", value))`
      }
      const code =
        `func ${name}(value ${source ? typeName(source.name) : 'string'}) ${target} {\n\tswitch value {\n${[...cases, fallback].join('\n')}\n\t}\n}`.replace(
          /\n(case|default|\treturn|\tpanic)/g,
          '\n\t$1',
        )
      this.enumHelpers.set(name, { key, code })
    }
    return name
  }

  syntax(): Syntax {
    return {
      access: (base, _step, name) => `${base}.${name}`,
      literal: (value, type) => this.literal(value, type),
      convert: (expr, from, to) => this.convert(expr, from, to),
      concat: (parts, separator) => parts.join(` + ${quote(separator)} + `),
      split: (expr, separator, part) => {
        this.imports.add('strings')
        const sep = quote(separator)
        if (part === 0) return `strings.SplitN(${expr}, ${sep}, 2)[0]`
        if (part === 'last') return `${expr}[strings.LastIndex(${expr}, ${sep})+${separator.length}:]`
        if (part === 'rest') return `strings.TrimPrefix(strings.TrimPrefix(${expr}, strings.SplitN(${expr}, ${sep}, 2)[0]), ${sep})`
        return `strings.Split(${expr}, ${sep})[${part}]`
      },
      boolean: (expr, trueValues, from) => {
        const enumDef = from.kind === 'enum' ? findEnum(this.plan.source, from.name) : undefined
        return trueValues.map((value) => `${expr} == ${enumDef ? this.constant(enumDef, value) : quote(value)}`).join(' || ')
      },
      enumMap: (expr, node) => `${this.enumHelper({ ...node, type: { kind: 'enum', name: node.target.name }, nullable: false })}(${expr})`,
      epoch: (expr, unit, toDate, from) => {
        this.imports.add('time')
        if (toDate) {
          const whole = isPrimitive(from, 'float') ? `int64(${expr})` : expr
          return unit === 'seconds' ? `time.Unix(${whole}, 0).UTC()` : `time.UnixMilli(${whole}).UTC()`
        }
        return unit === 'seconds' ? `${expr}.Unix()` : `${expr}.UnixMilli()`
      },
      arithmetic: (expr, operator, value, type) =>
        `${expr} ${operator} ${isPrimitive(type, 'float', 'decimal') && Number.isInteger(value) ? `${value}.0` : value}`,
      mapperCall: (mapper, expr) => `${this.functionName(mapper, false)}(${expr}${this.errsArgument()})`,
      list: (expr, item, element, isMap, elementIsItem) => {
        const helper = isMap ? 'mapValues' : 'mapSlice'
        if (elementIsItem) return expr
        this.helpers.add(helper)
        const call = new RegExp(`^(\\w+)\\(${item}${this.fallible ? ', errs' : ''}\\)$`).exec(element)
        if (call && !this.fallible) return `${helper}(${expr}, ${call[1]})`
        return `${helper}(${expr}, func(${item} ${this.listItemType}) ${this.listResultType} {\n\treturn ${element}\n})`
      },
      coalesce: (expr, fallback) => {
        this.helpers.add('valueOr')
        return `valueOr(${expr}, ${fallback})`
      },
      nullSafe: (expr, build, context) => {
        this.helpers.add('mapPointer')
        const result = context.resultNullable ? `*${this.goType(context.resultType, 'target')}` : this.goType(context.resultType, 'target')
        return `mapPointer(${expr}, func(${context.variable} ${this.goType(context.type, 'source')}) ${result} {\n\treturn ${build(context.variable)}\n})`
      },
      wrapOptional: (expr, type) => {
        // A nullable Go field is a pointer: a present value is passed by address
        if (type.kind === 'array' || type.kind === 'map') return expr
        this.helpers.add('pointerTo')
        return `pointerTo(${expr})`
      },
      unwrap: (expr) => `*${expr}`,
      placeholder: (type) => this.placeholder(type),
      expression: {
        lengthBits: 64,
        binary: (operator, left, right) => {
          if (operator === '??') {
            this.helpers.add('valueOr')
            return `valueOr(${left}, ${right})`
          }
          return `${left} ${operator} ${right}`
        },
        not: (value) => `!${value}`,
        conditional: (condition, then, otherwise, type) =>
          `func() ${type ? this.goType(type, 'target') : 'any'} {\n\tif ${condition} {\n\t\treturn ${then}\n\t}\n\treturn ${otherwise}\n}()`,
        call: (name, args, types) => {
          const [a, b, c] = args
          switch (name) {
            case 'upper':
              this.imports.add('strings')
              return `strings.ToUpper(${a})`
            case 'lower':
              this.imports.add('strings')
              return `strings.ToLower(${a})`
            case 'trim':
              this.imports.add('strings')
              return `strings.TrimSpace(${a})`
            case 'length':
              return `int64(len([]rune(${a})))`
            case 'concat':
              this.imports.add('fmt')
              return `fmt.Sprint(${args.join(', ')})`
            case 'substring':
              return c === undefined ? `string([]rune(${a})[${b}:])` : `string([]rune(${a})[${b}:${b}+${c}])`
            case 'replace':
              this.imports.add('strings')
              return `strings.ReplaceAll(${a}, ${b}, ${c})`
            case 'abs':
              // math.Abs only takes a float64
              if (types[0] && isPrimitive(types[0], 'integer')) return `max(${a}, -${a})`
              this.imports.add('math')
              return `math.Abs(${a})`
            case 'round':
            case 'floor':
            case 'ceil':
              this.imports.add('math')
              return `math.${name.charAt(0).toUpperCase()}${name.slice(1)}(${a})`
            case 'min':
            case 'max':
              return `${name}(${a}, ${b})`
            case 'toString':
              this.imports.add('fmt')
              return `fmt.Sprint(${a})`
            case 'toNumber':
              return `parseFloat[float64](${a}${this.errsArgument()})`
          }
        },
      },
    }
  }

  /** Types of the element closures of the list being written (set while writing each assignment). */
  listItemType = 'any'
  listResultType = 'any'

  placeholder(type: TypeRef): string {
    if (type.kind === 'primitive') {
      if (isPrimitive(type, 'string', 'uuid')) return '""'
      if (isNumber(type)) return '0'
      if (isPrimitive(type, 'boolean')) return 'false'
    }
    return `*new(${this.goType(type, 'target')})`
  }

  /** The element types of a list value, for its closure's signature. */
  private prepareList(value: Value | null) {
    if (!value) return
    let list: Value | null = null
    const find = (node: Value) => {
      if (list) return
      if (node.k === 'list') list = node
      else if ('value' in node && node.value && typeof node.value === 'object' && 'k' in node.value) find(node.value as Value)
    }
    find(value)
    if (!list) return
    const found = list as Extract<Value, { k: 'list' }>
    const sourceItems =
      found.value.type.kind === 'array'
        ? found.value.type.items
        : found.value.type.kind === 'map'
          ? found.value.type.value
          : found.value.type
    const targetItems = found.type.kind === 'array' ? found.type.items : found.type.kind === 'map' ? found.type.value : found.type
    this.listItemType = this.goType(sourceItems, 'source')
    this.listResultType = this.goType(targetItems, 'target')
  }

  mapperFunction(mapper: MapperPlan): string {
    const roots = { source: 'source', item: 'item', depth: 0, lists: 0 }
    const lines: string[] = []
    for (const assignment of mapper.assignments) {
      this.prepareList(assignment.value)
      const code = this.emitter.assignment(assignment, roots)
      if (code === null) continue
      if (assignment.missing) lines.push(`// TODO: no value for "${assignment.field.name}" in the mapping`)
      else if (assignment.unsafeNull) lines.push(`// "${assignment.field.name}" is required: panics if the source is missing`)
      lines.push(`${this.name(assignment.field, 'target')}: ${code},`)
    }
    const target = typeName(mapper.target.name)
    const body = lines.length > 0 ? `${target}{\n${indent(lines.join('\n'), 2)}\n}` : `${target}{}`
    const parameters = `source ${typeName(mapper.source.name)}${this.fallible ? ', errs *[]error' : ''}`
    return `func ${this.functionName(mapper, false)}(${parameters}) ${target} {\n\treturn ${body.replace(/\n/g, '\n\t')}\n}`.replace(
      / {2}/g,
      '\t',
    )
  }

  /** The exported entry point: returns the errors of the conversions that failed. */
  entryPoint(): string {
    const root = this.plan.root
    const source = typeName(root.source.name)
    const target = typeName(root.target.name)
    const name = this.functionName(root, true)
    if (!this.fallible)
      return `// ${name} maps a ${source} to a ${target}.\nfunc ${name}(source ${source}) ${target} {\n\treturn ${this.functionName(root, false)}(source)\n}`
    this.imports.add('errors')
    return `// ${name} maps a ${source} to a ${target}. The error lists every value that could not be converted.\nfunc ${name}(source ${source}) (${target}, error) {\n\tvar errs []error\n\ttarget := ${this.functionName(root, false)}(source, &errs)\n\treturn target, errors.Join(errs...)\n}`
  }

  parseHelpers(code: string): string[] {
    const helpers: string[] = []
    const errs = this.fallible
    if (code.includes('parseInt[')) {
      this.imports.add('strconv')
      helpers.push(
        `func parseInt[T int8 | int16 | int32 | int64](text string${errs ? ', errs *[]error' : ''}) T {\n\tvalue, err := strconv.ParseInt(text, 10, 64)\n\tif err != nil {\n\t\t${errs ? '*errs = append(*errs, err)' : 'panic(err)'}\n\t}\n\treturn T(value)\n}`,
      )
    }
    if (code.includes('parseFloat[')) {
      this.imports.add('strconv')
      helpers.push(
        `func parseFloat[T float32 | float64](text string${errs ? ', errs *[]error' : ''}) T {\n\tvalue, err := strconv.ParseFloat(text, 64)\n\tif err != nil {\n\t\t${errs ? '*errs = append(*errs, err)' : 'panic(err)'}\n\t}\n\treturn T(value)\n}`,
      )
    }
    if (code.includes('parseTime(')) {
      this.imports.add('time')
      helpers.push(
        `func parseTime(text, layout string${errs ? ', errs *[]error' : ''}) time.Time {\n\tvalue, err := time.Parse(layout, text)\n\tif err != nil {\n\t\t${errs ? '*errs = append(*errs, err)' : 'panic(err)'}\n\t}\n\treturn value\n}`,
      )
    }
    return helpers
  }
}

function generate(plan: Plan, settings: GenerateSettings): GeneratedCode {
  const writer = new GoWriter(plan, settings)
  const functions = plan.mappers.map((mapper) => writer.mapperFunction(mapper))
  const entry = writer.entryPoint()
  const enumHelpers = [...writer.enumHelpers.values()].map((helper) => helper.code)
  const body = [entry, ...functions, ...enumHelpers].join('\n\n')
  const parse = writer.parseHelpers(body)
  const generic = [...writer.helpers].sort().map((name) => HELPERS[name])
  const pkg = optionValue(goGenerator, plan, settings, 'package') || 'mapping'
  const imports = [...writer.imports].sort()
  const importBlock =
    imports.length === 0
      ? ''
      : imports.length === 1
        ? `import ${quote(imports[0])}`
        : `import (\n${imports.map((item) => `\t${quote(item)}`).join('\n')}\n)`
  const code = `${[`package ${pkg}`, importBlock, body, ...parse, ...generic].filter((part) => part !== '').join('\n\n')}\n`
  return { files: [{ name: 'mapping.go', code }], notes: writer.emitter.notes }
}

export const goGenerator: CodeGenerator = {
  id: 'go',
  label: 'Go',
  editorLanguage: 'go',
  modes: ['functions'],
  options: [{ id: 'package', kind: 'text', choices: ['mapping'] }],
  defaults: (plan) =>
    plan.target.origin?.language === 'go' && plan.root.target.namespace
      ? { package: plan.root.target.namespace }
      : ({} as Record<string, string>),
  generate,
}
