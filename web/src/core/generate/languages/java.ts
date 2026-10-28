import { toScreamingSnakeCase } from '../../model/naming.ts'
import { findEnum, type EnumDef, type FieldDef, type Literal, type ModelDef, type ModelSchema, type TypeRef } from '../../model/schema.ts'
import { Emitter, indent, quote, type Syntax } from '../emitter.ts'
import { fieldName, isValidIdentifier, typeName, type NamingRules } from '../naming.ts'
import { type Assignment, type MapperPlan, type Plan, type Value } from '../plan.ts'
import { optionValue, type CodeGenerator, type GeneratedCode, type GenerateSettings } from '../types.ts'

const RESERVED = new Set([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'try',
  'void',
  'volatile',
  'while',
  'record',
  'var',
  'yield',
])

const NAMING: NamingRules = { language: 'java', convention: 'camelCase', reserved: RESERVED, escape: (name) => `${name}_` }

const isNumber = (type: TypeRef) => type.kind === 'primitive' && ['integer', 'float', 'decimal'].includes(type.name)
const isPrimitive = (type: TypeRef, ...names: string[]) => type.kind === 'primitive' && names.includes(type.name)

const DATE_TIME_CLASSES = ['OffsetDateTime', 'LocalDateTime', 'ZonedDateTime', 'Instant', 'Date']

/** The Java class used for date-times on one side: the one the models declare, OffsetDateTime otherwise. */
function dateTimeClass(schema: ModelSchema): string {
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (isPrimitive(field.type, 'datetime') && schema.origin?.language === 'java') {
        const declared = field.originalType?.replace(/^.*\./, '')
        if (declared && DATE_TIME_CLASSES.includes(declared)) return declared
      }
    }
  }
  return 'OffsetDateTime'
}

function operand(code: string): string {
  return /^[\w.()"]+$/.test(code) && !code.includes(' ') ? code : `(${code})`
}

class JavaWriter {
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

  use(name: string) {
    this.imports.add(name)
  }

  /** A model's name in code: `Outer.Inner` for nested classes. */
  className(model: ModelDef): string {
    const outer = model.metadata?.outer
    return typeof outer === 'string' ? `${outer}.${typeName(model.name)}` : typeName(model.name)
  }

  enumClass(enumDef: EnumDef): string {
    return typeName(enumDef.name)
  }

  enumConstant(enumDef: EnumDef, name: string): string {
    // Enums from documents are written as Java constants: "in_progress" → IN_PROGRESS
    return isValidIdentifier(name) && !(enumDef.kind === 'literals' && /[a-z]/.test(name)) ? name : toScreamingSnakeCase(name) || 'VALUE'
  }

  methodName(mapper: MapperPlan): string {
    return `to${typeName(mapper.target.name)}`
  }

  private getter(owner: ModelDef, field: FieldDef, name: string): string {
    const style = owner.metadata?.accessors ?? 'getters'
    if (style === 'record') return `${name}()`
    if (style === 'fields') return name
    const primitiveBoolean = isPrimitive(field.type, 'boolean') && !field.nullable && this.plan.source.origin?.language === 'java'
    return `${primitiveBoolean ? 'is' : 'get'}${name.charAt(0).toUpperCase()}${name.slice(1)}()`
  }

  literal(value: Literal, type: TypeRef): string {
    if (value === null) return 'null'
    if (type.kind === 'enum' && typeof value === 'string') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef) return `${this.enumClass(enumDef)}.${this.enumConstant(enumDef, value)}`
    }
    if (typeof value === 'number') {
      if (isPrimitive(type, 'decimal')) {
        this.use('java.math.BigDecimal')
        return `new BigDecimal(${quote(String(value))})`
      }
      if (isPrimitive(type, 'float')) return Number.isInteger(value) ? `${value}.0` : String(value)
      if (isPrimitive(type, 'integer') && type.kind === 'primitive' && type.bits === 64) return `${value}L`
      return String(value)
    }
    if (typeof value === 'string' && isPrimitive(type, 'datetime')) {
      this.use(`java.time.${this.targetDateTime}`)
      return `${this.targetDateTime}.parse(${quote(value)})`
    }
    return typeof value === 'string' ? quote(value) : String(value)
  }

  convert(expr: string, from: TypeRef, to: TypeRef): string {
    if (isNumber(from) && isNumber(to) && from.kind === 'primitive' && to.kind === 'primitive') {
      if (to.name === 'decimal') {
        if (from.name === 'decimal') return expr
        this.use('java.math.BigDecimal')
        return `BigDecimal.valueOf(${expr})`
      }
      if (from.name === 'decimal')
        return to.name === 'integer'
          ? to.bits === 32
            ? `${operand(expr)}.intValueExact()`
            : `${operand(expr)}.longValueExact()`
          : `${operand(expr)}.doubleValue()`
      if (to.name === 'float') return from.name === 'float' ? expr : `(double) ${operand(expr)}`
      // To an integer: from a float drops the decimals; from a wider integer it must fit
      if (from.name === 'float') return to.bits === 32 ? `(int) (double) ${operand(expr)}` : `(long) (double) ${operand(expr)}`
      if (to.bits === 32 && from.bits !== 32) return `Math.toIntExact(${expr})`
      if (to.bits === 64 && from.bits !== 64) return `(long) ${operand(expr)}`
      return expr
    }
    if (isPrimitive(to, 'string')) {
      if (from.kind === 'enum') return `${operand(expr)}.name()`
      if (isPrimitive(from, 'decimal')) return `${operand(expr)}.toPlainString()`
      if (isPrimitive(from, 'string')) return expr
      if (isPrimitive(from, 'datetime', 'date', 'time', 'uuid', 'duration')) return `${operand(expr)}.toString()`
      return `String.valueOf(${expr})`
    }
    if (isPrimitive(from, 'string', 'any')) {
      const text = isPrimitive(from, 'any') ? `String.valueOf(${expr})` : expr
      if (to.kind === 'primitive') {
        switch (to.name) {
          case 'integer':
            return to.bits === 32 ? `Integer.parseInt(${text})` : `Long.parseLong(${text})`
          case 'float':
            return `Double.parseDouble(${text})`
          case 'decimal':
            this.use('java.math.BigDecimal')
            return `new BigDecimal(${text})`
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
      if (to.kind === 'enum') {
        const enumDef = findEnum(this.plan.target, to.name)
        return `${enumDef ? this.enumClass(enumDef) : typeName(to.name)}.valueOf(${text})`
      }
    }
    if (isPrimitive(from, 'date') && isPrimitive(to, 'datetime')) {
      this.use('java.time.ZoneOffset')
      return this.targetDateTime === 'LocalDateTime'
        ? `${operand(expr)}.atStartOfDay()`
        : `${operand(expr)}.atStartOfDay().atOffset(ZoneOffset.UTC)`
    }
    if (isPrimitive(from, 'datetime') && isPrimitive(to, 'date')) return `${operand(expr)}.toLocalDate()`
    if (isPrimitive(from, 'datetime') && isPrimitive(to, 'datetime') && this.sourceDateTime !== this.targetDateTime) {
      this.use(`java.time.${this.targetDateTime}`)
      this.use('java.time.ZoneOffset')
      if (this.targetDateTime === 'Instant') return `${operand(expr)}.toInstant()`
      const instant = this.sourceDateTime === 'Instant' ? expr : `${operand(expr)}.toInstant()`
      return `${this.targetDateTime}.ofInstant(${instant}, ZoneOffset.UTC)`
    }
    if (isPrimitive(from, 'boolean') && isPrimitive(to, 'integer')) return `${operand(expr)} ? 1 : 0`
    return expr
  }

  private enumHelper(node: Extract<Value, { k: 'enumMap' }>): string {
    const source = node.source
    const base = `to${this.enumClass(node.target)}`
    const key = JSON.stringify([node.pairs, node.fallback, source?.name])
    let name = base
    for (let n = 2; this.helpers.has(name) && this.helpers.get(name)!.key !== key; n++) name = `${base}${n}`
    if (!this.helpers.has(name)) {
      const target = this.enumClass(node.target)
      const cases = node.pairs.map(
        (pair) =>
          `            case ${source ? this.enumConstant(source, pair.from) : quote(pair.from)} -> ${target}.${this.enumConstant(node.target, pair.to)};`,
      )
      const fallback =
        node.fallback !== undefined
          ? `            default -> ${target}.${this.enumConstant(node.target, node.fallback)};`
          : `            default -> throw new IllegalArgumentException("Unexpected ${source?.name ?? 'value'}: " + value);`
      const parameter = source ? this.enumClass(source) : 'String'
      const code = `    private static ${target} ${name}(${parameter} value) {\n        return switch (value) {\n${[...cases, fallback].join('\n')}\n        };\n    }`
      this.helpers.set(name, { key, code })
    }
    return name
  }

  syntax(): Syntax {
    return {
      access: (base, step, name) => {
        const read = `${base}.${this.getter(step.owner, step.field, name)}`
        // A getter returning Optional<T>: the mapping works with the value or null
        return step.field.originalType?.startsWith('Optional<') ? `${read}.orElse(null)` : read
      },
      literal: (value, type) => this.literal(value, type),
      convert: (expr, from, to) => this.convert(expr, from, to),
      concat: (parts, separator) => parts.join(` + ${quote(separator)} + `),
      split: (expr, separator, part) => {
        const sep = quote(separator)
        if (part === 0)
          return `${operand(expr)}.split(${/^[\w ,;:-]$/.test(separator) ? sep : `java.util.regex.Pattern.quote(${sep})`}, -1)[0]`
        if (part === 'last') return `${operand(expr)}.substring(${operand(expr)}.lastIndexOf(${sep}) + ${separator.length})`
        if (part === 'rest')
          return `${operand(expr)}.contains(${sep}) ? ${operand(expr)}.substring(${operand(expr)}.indexOf(${sep}) + ${separator.length}) : ""`
        return `${operand(expr)}.split(java.util.regex.Pattern.quote(${sep}), -1)[${part}]`
      },
      boolean: (expr, trueValues, from) => {
        const enumDef = from.kind === 'enum' ? findEnum(this.plan.source, from.name) : undefined
        if (enumDef)
          return trueValues.map((value) => `${expr} == ${this.enumClass(enumDef)}.${this.enumConstant(enumDef, value)}`).join(' || ')
        if (trueValues.length === 1) return `${quote(trueValues[0])}.equals(${expr})`
        this.use('java.util.Set')
        return `Set.of(${trueValues.map(quote).join(', ')}).contains(${expr})`
      },
      enumMap: (expr, node) => `${this.enumHelper({ ...node, type: { kind: 'enum', name: node.target.name }, nullable: false })}(${expr})`,
      epoch: (expr, unit, toDate, from) => {
        this.use('java.time.Instant')
        if (toDate) {
          // Instant takes a long: a floating number of seconds is truncated
          const whole = isPrimitive(from, 'float') ? `(long) ${operand(expr)}` : expr
          const instant = unit === 'seconds' ? `Instant.ofEpochSecond(${whole})` : `Instant.ofEpochMilli(${whole})`
          if (this.targetDateTime === 'Instant') return instant
          this.use(`java.time.${this.targetDateTime}`)
          this.use('java.time.ZoneOffset')
          return `${this.targetDateTime}.ofInstant(${instant}, ZoneOffset.UTC)`
        }
        const instant = this.sourceDateTime === 'Instant' ? expr : `${operand(expr)}.toInstant()`
        return unit === 'seconds' ? `${operand(instant)}.getEpochSecond()` : `${operand(instant)}.toEpochMilli()`
      },
      arithmetic: (expr, operator, value, type) => {
        if (isPrimitive(type, 'decimal')) {
          this.use('java.math.BigDecimal')
          const method = { '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide' }[operator]
          if (operator === '/') this.use('java.math.MathContext')
          return `${operand(expr)}.${method}(BigDecimal.valueOf(${value})${operator === '/' ? ', MathContext.DECIMAL128' : ''})`
        }
        const literal = isPrimitive(type, 'float') && Number.isInteger(value) ? `${value}.0` : String(value)
        return `${operand(expr)} ${operator} ${literal}`
      },
      mapperCall: (mapper, expr) => `${this.methodName(mapper)}(${expr})`,
      list: (expr, item, element, isMap, elementIsItem, container) => {
        const isSet = /Set$/.test(container ?? '')
        if (isMap) {
          if (elementIsItem) {
            this.use('java.util.HashMap')
            return `new HashMap<>(${expr})`
          }
          this.use('java.util.Map')
          this.use('java.util.stream.Collectors')
          return `${operand(expr)}.entrySet().stream().collect(Collectors.toMap(Map.Entry::getKey, entry -> ${element.split(item).join('entry.getValue()')}))`
        }
        if (elementIsItem) {
          this.use(isSet ? 'java.util.HashSet' : 'java.util.ArrayList')
          return `new ${isSet ? 'HashSet' : 'ArrayList'}<>(${expr})`
        }
        const call = /^(\w+)\((\w+)\)$/.exec(element)
        const mapping = call && call[2] === item ? `${this.mapperClass()}::${call[1]}` : `${item} -> ${element}`
        if (isSet) {
          this.use('java.util.stream.Collectors')
          return `${operand(expr)}.stream().map(${mapping}).collect(Collectors.toSet())`
        }
        return `${operand(expr)}.stream().map(${mapping}).toList()`
      },
      coalesce: (expr, fallback) => {
        this.use('java.util.Objects')
        return `Objects.requireNonNullElse(${expr}, ${fallback})`
      },
      nullSafe: (expr, build) => `${operand(expr)} != null ? ${build(expr)} : null`,
      unwrap: (expr) => {
        this.use('java.util.Objects')
        return `Objects.requireNonNull(${expr})`
      },
      placeholder: (type) => this.placeholder(type),
      expression: {
        binary: (operator, left, right) => {
          if (operator === '==' || operator === '!=') {
            this.use('java.util.Objects')
            return `${operator === '!=' ? '!' : ''}Objects.equals(${left}, ${right})`
          }
          if (operator === '??') {
            this.use('java.util.Objects')
            return `Objects.requireNonNullElse(${left}, ${right})`
          }
          return `${left} ${operator} ${right}`
        },
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
              return `${operand(a)}.strip()`
            case 'length':
              return `${operand(a)}.length()`
            case 'concat':
              return args.map((arg) => `String.valueOf(${arg})`).join(' + ')
            case 'substring':
              return c === undefined ? `${operand(a)}.substring(${b})` : `${operand(a)}.substring(${b}, ${operand(b)} + ${operand(c)})`
            case 'replace':
              return `${operand(a)}.replace(${b}, ${c})`
            case 'round':
            case 'floor':
            case 'ceil':
            case 'abs':
            case 'min':
            case 'max':
              return `Math.${name}(${args.join(', ')})`
            case 'toString':
              return `String.valueOf(${a})`
            case 'toNumber':
              return `Double.parseDouble(${a})`
          }
        },
      },
    }
  }

  placeholder(type: TypeRef): string {
    if (type.kind === 'array') {
      this.use('java.util.List')
      return 'List.of()'
    }
    if (type.kind === 'map') {
      this.use('java.util.Map')
      return 'Map.of()'
    }
    if (type.kind === 'primitive') {
      switch (type.name) {
        case 'string':
          return '""'
        case 'integer':
          return type.bits === 64 ? '0L' : '0'
        case 'float':
          return '0.0'
        case 'boolean':
          return 'false'
        case 'decimal':
          this.use('java.math.BigDecimal')
          return 'BigDecimal.ZERO'
      }
    }
    return 'null'
  }

  mapperClass(): string {
    return `${typeName(this.plan.root.source.name)}Mapper`
  }

  /** `target.setName(value);`, a builder call, or constructor arguments, depending on the target model. */
  private build(mapper: MapperPlan, values: { assignment: Assignment; code: string | null }[]): string[] {
    const target = this.className(mapper.target)
    const comments = (assignment: Assignment) =>
      assignment.missing
        ? [`// TODO: no value for "${assignment.field.name}" in the mapping`]
        : assignment.unsafeNull
          ? [`// "${assignment.field.name}" is required: fails if the source is missing`]
          : []
    if (mapper.target.construction === 'positional' || mapper.target.kind === 'record') {
      const args = values.flatMap(({ assignment, code }) => [...comments(assignment), `${code ?? 'null'},`])
      const last = args.length - 1
      if (last >= 0) args[last] = args[last].replace(/,$/, '')
      return [`return new ${target}(`, ...indent(args.join('\n'), 8).split('\n'), ');'].filter((line) => line !== '')
    }
    if (mapper.target.metadata?.builder) {
      const calls = values
        .filter(({ code }) => code !== null)
        .flatMap(({ assignment, code }) => [...comments(assignment), `.${this.name(assignment.field, 'target')}(${code})`])
      return [`return ${target}.builder()`, ...calls.map((line) => `        ${line}`), '        .build();']
    }
    const fields = mapper.target.metadata?.accessors === 'fields'
    const lines = [`${target} target = new ${target}();`]
    for (const { assignment, code } of values) {
      if (code === null) continue
      lines.push(...comments(assignment))
      const name = this.name(assignment.field, 'target')
      lines.push(fields ? `target.${name} = ${code};` : `target.set${name.charAt(0).toUpperCase()}${name.slice(1)}(${code});`)
    }
    lines.push('return target;')
    return lines
  }

  mapperMethod(mapper: MapperPlan): string {
    const roots = { source: 'source', item: 'item', depth: 0, lists: 0 }
    const values = mapper.assignments.map((assignment) => ({ assignment, code: this.emitter.assignment(assignment, roots) }))
    const body = ['if (source == null) {', '    return null;', '}', ...this.build(mapper, values)]
    return `    public static ${this.className(mapper.target)} ${this.methodName(mapper)}(${this.className(mapper.source)} source) {\n${indent(body.join('\n'), 8)}\n    }`
  }

  modelImports(): string[] {
    const imports = new Set<string>()
    const add = (schema: ModelSchema, model: { name: string; namespace?: string; metadata?: ModelDef['metadata'] }) => {
      if (schema.origin?.language !== 'java' || !model.namespace) return
      const outer = typeof model.metadata?.outer === 'string' ? model.metadata.outer.split('.')[0] : typeName(model.name)
      imports.add(`${model.namespace}.${outer}`)
    }
    for (const mapper of this.plan.mappers) {
      add(this.plan.source, mapper.source)
      add(this.plan.target, mapper.target)
    }
    for (const enumDef of this.plan.enums.source) add(this.plan.source, enumDef)
    for (const enumDef of this.plan.enums.target) add(this.plan.target, enumDef)
    return [...imports]
  }

  header(): string {
    const pkg = optionValue(javaGenerator, this.plan, this.settings, 'package')
    const imports = [...new Set([...this.imports, ...this.modelImports()])]
      .filter((item) => !item.startsWith(`${pkg}.`) || item.slice(pkg.length + 1).includes('.'))
      .sort()
    const java = imports.filter((item) => item.startsWith('java.'))
    const other = imports.filter((item) => !item.startsWith('java.'))
    const blocks = [
      pkg ? `package ${pkg};` : '',
      other.map((item) => `import ${item};`).join('\n'),
      java.map((item) => `import ${item};`).join('\n'),
    ]
    return blocks.filter((block) => block !== '').join('\n\n')
  }
}

function generateManual(plan: Plan, settings: GenerateSettings): GeneratedCode {
  const writer = new JavaWriter(plan, settings)
  const methods = plan.mappers.map((mapper) => writer.mapperMethod(mapper))
  const helpers = [...writer.helpers.values()].map((helper) => helper.code)
  const name = writer.mapperClass()
  const body = [`    private ${name}() {\n    }`, ...methods, ...helpers].join('\n\n')
  const code = `${[writer.header(), `public final class ${name} {\n\n${body}\n}`].filter((part) => part !== '').join('\n\n')}\n`
  return { files: [{ name: `${name}.java`, code }], notes: writer.emitter.notes }
}

/** MapStruct: `@Mapping` only where names differ or a transformation is needed; nested objects and
 * lists are mapped by the methods of the other model pairs. */
function generateMapStruct(plan: Plan, settings: GenerateSettings): GeneratedCode {
  const writer = new JavaWriter(plan, settings)
  const component = optionValue(javaGenerator, plan, settings, 'componentModel')
  const javaImports = new Set<string>()
  const methods: string[] = []
  const valueMappings = new Map<string, string>()

  for (const mapper of plan.mappers) {
    const annotations: string[] = []
    for (const assignment of mapper.assignments) {
      const target = writer.name(assignment.field, 'target')
      const value = assignment.value
      const attributes: string[] = []
      if (!value) {
        if (assignment.missing) annotations.push(`    // TODO: no value for "${assignment.field.name}" in the mapping`)
        annotations.push(`    @Mapping(target = ${quote(target)}, ignore = true)`)
        continue
      }
      const sourcePath = (node: Value): string | null => {
        if (node.k === 'path') return node.steps.map((step) => writer.name(step.field, 'source')).join('.')
        if (node.k === 'self') return '.'
        return null
      }
      // Values MapStruct converts by itself: a field read as is, a nested object or list mapped by another method, an enum by its @ValueMapping
      const simple = value.k === 'convert' ? value.value : value.k === 'coalesce' ? value.value : value
      const inner = simple.k === 'convert' ? simple.value : simple
      const direct =
        inner.k === 'path' || inner.k === 'self'
          ? inner
          : inner.k === 'mapper' || inner.k === 'list' || inner.k === 'enumMap'
            ? inner.value
            : null
      const path = direct ? sourcePath(direct) : null
      if (value.k === 'literal') {
        if (value.value === null) attributes.push('expression = "java(null)"')
        else attributes.push(`constant = ${quote(String(value.value))}`)
      } else if (
        path !== null &&
        (inner.k !== 'list' || inner.element.k === 'mapper' || inner.element.k === 'self' || inner.element.k === 'convert')
      ) {
        if (path !== target) attributes.push(`source = ${quote(path)}`)
        if (value.k === 'coalesce' && value.fallback.k === 'literal' && value.fallback.value !== null)
          attributes.push(`defaultValue = ${quote(String(value.fallback.value))}`)
        if (inner.k === 'enumMap') {
          const key = `${inner.source?.name ?? 'String'}->${inner.target.name}`
          if (!valueMappings.has(key)) {
            const lines = inner.pairs.map(
              (pair) =>
                `    @ValueMapping(source = ${quote(inner.source ? writer.enumConstant(inner.source, pair.from) : pair.from)}, target = ${quote(writer.enumConstant(inner.target, pair.to))})`,
            )
            if (inner.fallback !== undefined)
              lines.push(
                `    @ValueMapping(source = MappingConstants.ANY_REMAINING, target = ${quote(writer.enumConstant(inner.target, inner.fallback))})`,
              )
            // Values without a pair fail at run time, as in the manual mapper (MapStruct 1.5+)
            else if (inner.pairs.length < (inner.source?.values.length ?? Infinity))
              lines.push('    @ValueMapping(source = MappingConstants.ANY_REMAINING, target = MappingConstants.THROW_EXCEPTION)')
            lines.push(
              `    ${writer.enumClass(inner.target)} ${`to${writer.enumClass(inner.target)}`}(${inner.source ? writer.enumClass(inner.source) : 'String'} value);`,
            )
            valueMappings.set(key, lines.join('\n'))
          }
        }
        if (attributes.length === 0) continue
      } else {
        // Anything else is written as a Java expression over the source parameter
        const expression = writer.emitter.value(value, { source: 'source', item: 'item', depth: 0, lists: 0 })
        attributes.push(`expression = ${quote(`java(${expression})`)}`)
      }
      annotations.push(`    @Mapping(target = ${quote(target)}, ${attributes.join(', ')})`)
    }
    methods.push(
      [
        ...annotations,
        `    ${writer.className(mapper.target)} ${writer.methodName(mapper)}(${writer.className(mapper.source)} source);`,
      ].join('\n'),
    )
  }

  for (const item of writer.imports) javaImports.add(item)
  const expressionClasses = [...javaImports].filter(
    (item) => !['java.util.Set', 'java.util.List', 'java.util.Map', 'java.util.stream.Collectors'].includes(item),
  )
  const mapperAttributes: string[] = []
  if (component !== 'default') mapperAttributes.push(`componentModel = ${quote(component)}`)
  if (expressionClasses.length > 0)
    mapperAttributes.push(`imports = {${expressionClasses.map((item) => `${item.split('.').pop()}.class`).join(', ')}}`)
  const usesValueMappingConstants = [...valueMappings.values()].some((item) => item.includes('MappingConstants'))
  const mapstruct = [
    'org.mapstruct.Mapper',
    'org.mapstruct.Mapping',
    ...(valueMappings.size > 0 ? ['org.mapstruct.ValueMapping'] : []),
    ...(usesValueMappingConstants ? ['org.mapstruct.MappingConstants'] : []),
  ]
  const pkg = optionValue(javaGenerator, plan, settings, 'package')
  const imports = [...new Set([...javaImports, ...writer.modelImports(), ...mapstruct])].sort()
  const header = [
    pkg ? `package ${pkg};` : '',
    imports
      .filter((item) => !item.startsWith('java.'))
      .map((item) => `import ${item};`)
      .join('\n'),
    imports
      .filter((item) => item.startsWith('java.'))
      .map((item) => `import ${item};`)
      .join('\n'),
  ]
    .filter((block) => block !== '')
    .join('\n\n')
  const name = writer.mapperClass()
  const annotation = `@Mapper${mapperAttributes.length > 0 ? `(${mapperAttributes.join(', ')})` : ''}`
  const code = `${header}\n\n${annotation}\npublic interface ${name} {\n\n${[...methods, ...valueMappings.values()].join('\n\n')}\n}\n`
  return { files: [{ name: `${name}.java`, code }], notes: writer.emitter.notes }
}

export const javaGenerator: CodeGenerator = {
  id: 'java',
  label: 'Java',
  editorLanguage: 'java',
  modes: ['manual', 'mapstruct'],
  options: [
    { id: 'package', kind: 'text', choices: [''] },
    { id: 'componentModel', choices: ['default', 'spring', 'cdi', 'jakarta'] },
  ],
  defaults: (plan) => {
    const namespace = plan.target.origin?.language === 'java' ? plan.root.target.namespace : undefined
    return namespace ? { package: namespace } : ({} as Record<string, string>)
  },
  generate: (plan, settings) => (settings.mode === 'mapstruct' ? generateMapStruct(plan, settings) : generateManual(plan, settings)),
}
