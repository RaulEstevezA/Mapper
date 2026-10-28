import { toPascalCase, toSnakeCase } from '../../model/naming.ts'
import { findEnum, type EnumDef, type FieldDef, type Literal, type TypeRef } from '../../model/schema.ts'
import { Emitter, indent, quote, type Syntax } from '../emitter.ts'
import { fieldName, isValidIdentifier, typeName, type NamingRules } from '../naming.ts'
import type { MapperPlan, Plan, Value } from '../plan.ts'
import { optionValue, type CodeGenerator, type GeneratedCode, type GenerateSettings } from '../types.ts'

const RESERVED = new Set([
  'as',
  'break',
  'const',
  'continue',
  'crate',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
  'async',
  'await',
  'dyn',
])
const NAMING: NamingRules = { language: 'rust', convention: 'snake_case', reserved: RESERVED, escape: (name) => `r#${name}` }

const isPrimitive = (type: TypeRef, ...names: string[]) => type.kind === 'primitive' && names.includes(type.name)
const isNumber = (type: TypeRef) => isPrimitive(type, 'integer', 'float', 'decimal')
/** Values copied without `.clone()` */
const isCopy = (type: TypeRef) => isPrimitive(type, 'integer', 'float', 'boolean')

/** The Rust type of a value, for numeric casts. */
function rustNumber(type: TypeRef): string {
  if (type.kind !== 'primitive') return 'i64'
  if (type.name === 'float') return type.bits === 32 ? 'f32' : 'f64'
  if (type.name === 'decimal') return 'Decimal'
  return type.bits === 32 ? 'i32' : type.bits === 16 ? 'i16' : type.bits === 8 ? 'i8' : 'i64'
}

/** A reference to a value: fields read from `source` are borrowed; closure parameters already are references. */
function reference(expr: string): string {
  return /^source(\.\w+)+$/.test(expr) ? `&${expr}` : expr
}

class RustWriter {
  readonly plan: Plan
  readonly settings: GenerateSettings
  readonly emitter: Emitter
  readonly uses = new Set<string>()
  readonly helpers = new Map<string, { key: string; code: string }>()

  constructor(plan: Plan, settings: GenerateSettings) {
    this.plan = plan
    this.settings = settings
    this.emitter = new Emitter(this.syntax(), (field, _owner, side) => this.name(field, side))
  }

  name(field: FieldDef, side: 'source' | 'target'): string {
    return fieldName(field, side === 'source' ? this.plan.source : this.plan.target, NAMING, this.settings.naming)
  }

  variant(enumDef: EnumDef, name: string): string {
    const member = isValidIdentifier(name) && /^[A-Z]/.test(name) && !name.includes('_') ? name : toPascalCase(name) || 'Value'
    return `${typeName(enumDef.name)}::${member}`
  }

  literal(value: Literal, type: TypeRef): string {
    if (value === null) return 'None'
    if (type.kind === 'enum' && typeof value === 'string') {
      const enumDef = findEnum(this.plan.target, type.name)
      if (enumDef) return this.variant(enumDef, value)
    }
    if (typeof value === 'number') {
      if (isPrimitive(type, 'decimal')) {
        this.uses.add('rust_decimal::Decimal')
        return Number.isInteger(value) ? `Decimal::from(${value})` : `Decimal::from_str_exact(${quote(String(value))}).unwrap()`
      }
      return isPrimitive(type, 'float') && Number.isInteger(value) ? `${value}.0` : String(value)
    }
    if (typeof value === 'boolean') return String(value)
    return `${quote(value)}.to_string()`
  }

  private parse(expr: string, type: string, what: string): string {
    return `${expr}.parse::<${type}>().expect(${quote(`${what} is not valid`)})`
  }

  convert(expr: string, from: TypeRef, to: TypeRef): string {
    if (isNumber(from) && isNumber(to)) {
      if (isPrimitive(to, 'decimal')) {
        if (isPrimitive(from, 'decimal')) return expr
        this.uses.add('rust_decimal::Decimal')
        return isPrimitive(from, 'float') ? `Decimal::try_from(${expr}).expect("number out of range")` : `Decimal::from(${expr})`
      }
      if (isPrimitive(from, 'decimal')) {
        this.uses.add('rust_decimal::prelude::ToPrimitive')
        return isPrimitive(to, 'float')
          ? `${expr}.to_f64().expect("number out of range")`
          : `${expr}.to_i64().expect("number out of range")`
      }
      return rustNumber(from) === rustNumber(to) ? expr : `${expr} as ${rustNumber(to)}`
    }
    if (isPrimitive(to, 'string')) {
      if (isPrimitive(from, 'string')) return `${expr}.clone()`
      if (from.kind === 'enum') return `format!("{:?}", ${expr})`
      if (isPrimitive(from, 'datetime')) return `${expr}.to_rfc3339()`
      return `${expr}.to_string()`
    }
    if (isPrimitive(from, 'string')) {
      if (isNumber(to)) {
        if (isPrimitive(to, 'decimal')) this.uses.add('rust_decimal::Decimal')
        return this.parse(expr, rustNumber(to), 'number')
      }
      if (isPrimitive(to, 'datetime')) {
        this.uses.add('chrono::DateTime')
        this.uses.add('chrono::Utc')
        return this.parse(expr, 'DateTime<Utc>', 'date and time')
      }
      if (isPrimitive(to, 'date')) {
        this.uses.add('chrono::NaiveDate')
        return this.parse(expr, 'NaiveDate', 'date')
      }
      if (isPrimitive(to, 'uuid')) {
        this.uses.add('uuid::Uuid')
        return `Uuid::parse_str(${expr}).expect("id is not valid")`
      }
      if (to.kind === 'enum') return this.parse(expr, typeName(to.name), 'value')
    }
    if (isPrimitive(from, 'boolean') && isPrimitive(to, 'integer')) return `${expr} as ${rustNumber(to)}`
    if (isPrimitive(from, 'datetime') && isPrimitive(to, 'date')) return `${expr}.date_naive()`
    return isCopy(from) ? expr : `${expr}.clone()`
  }

  private enumHelper(node: Extract<Value, { k: 'enumMap' }>): string {
    const source = node.source
    const name = `to_${toSnakeCase(node.target.name)}`
    const key = JSON.stringify([node.pairs, node.fallback, source?.name])
    let unique = name
    for (let n = 2; this.helpers.has(unique) && this.helpers.get(unique)!.key !== key; n++) unique = `${name}_${n}`
    if (!this.helpers.has(unique)) {
      const arms = node.pairs.map(
        (pair) => `${source ? this.variant(source, pair.from) : quote(pair.from)} => ${this.variant(node.target, pair.to)},`,
      )
      const complete = source !== undefined && node.pairs.length >= source.values.length
      if (node.fallback !== undefined) arms.push(`_ => ${this.variant(node.target, node.fallback)},`)
      else if (!complete) arms.push(`_ => panic!("unexpected ${source?.name ?? 'value'}: {:?}", value),`)
      const parameter = source ? `&${typeName(source.name)}` : '&str'
      const code = `fn ${unique}(value: ${parameter}) -> ${typeName(node.target.name)} {\n    match value {\n${indent(arms.join('\n'), 8)}\n    }\n}`
      this.helpers.set(unique, { key, code })
    }
    return unique
  }

  syntax(): Syntax {
    return {
      access: (base, _step, name) => `${base}.${name}`,
      literal: (value, type) => this.literal(value, type),
      convert: (expr, from, to) => this.convert(expr, from, to),
      concat: (parts, separator) =>
        `format!(${quote(parts.map(() => '{}').join(separator.replace(/[{}]/g, (char) => char + char)))}, ${parts.join(', ')})`,
      split: (expr, separator, part) => {
        const sep = quote(separator)
        if (part === 0) return `${expr}.split(${sep}).next().unwrap_or_default().to_string()`
        if (part === 'last') return `${expr}.rsplit(${sep}).next().unwrap_or_default().to_string()`
        if (part === 'rest') return `${expr}.split_once(${sep}).map(|(_, rest)| rest).unwrap_or_default().to_string()`
        return `${expr}.split(${sep}).nth(${part}).unwrap_or_default().to_string()`
      },
      boolean: (expr, trueValues, from) => {
        const enumDef = from.kind === 'enum' ? findEnum(this.plan.source, from.name) : undefined
        if (enumDef) return `matches!(${expr}, ${trueValues.map((value) => this.variant(enumDef, value)).join(' | ')})`
        return `matches!(${expr}.as_str(), ${trueValues.map(quote).join(' | ')})`
      },
      enumMap: (expr, node) =>
        `${this.enumHelper({ ...node, type: { kind: 'enum', name: node.target.name }, nullable: false })}(${reference(expr)})`,
      epoch: (expr, unit, toDate, from) => {
        this.uses.add('chrono::DateTime')
        if (toDate) {
          const whole = isPrimitive(from, 'float') ? `${expr} as i64` : expr
          return unit === 'seconds'
            ? `DateTime::from_timestamp(${whole}, 0).expect("timestamp out of range")`
            : `DateTime::from_timestamp_millis(${whole}).expect("timestamp out of range")`
        }
        return unit === 'seconds' ? `${expr}.timestamp()` : `${expr}.timestamp_millis()`
      },
      arithmetic: (expr, operator, value, type) => {
        if (isPrimitive(type, 'decimal')) {
          this.uses.add('rust_decimal::Decimal')
          return `${expr} ${operator} Decimal::from(${value})`
        }
        return `${expr} ${operator} ${isPrimitive(type, 'float') && Number.isInteger(value) ? `${value}.0` : value}`
      },
      mapperCall: (mapper, expr) => `${typeName(mapper.target.name)}::from(${reference(expr)})`,
      list: (expr, item, element, isMap, elementIsItem) => {
        if (isMap) return elementIsItem ? `${expr}.clone()` : `${expr}.iter().map(|(key, ${item})| (key.clone(), ${element})).collect()`
        if (elementIsItem) return `${expr}.iter().cloned().collect()`
        const call = new RegExp(`^(\\w+)::from\\(${item}\\)$`).exec(element)
        return call ? `${expr}.iter().map(${call[1]}::from).collect()` : `${expr}.iter().map(|${item}| ${element}).collect()`
      },
      coalesce: (expr, fallback, type) => {
        if (isCopy(type)) return `${expr}.unwrap_or(${fallback})`
        // An optional field read from the borrowed source is cloned before taking its value
        const owned = /^source(\.\w+)+$/.test(expr) ? `${expr}.clone()` : expr
        return `${owned}.unwrap_or_else(|| ${fallback})`
      },
      nullSafe: (expr, build, context) => {
        const inner = build(context.variable)
        // `.as_ref()` borrows the value inside; a nested optional is flattened with `and_then`
        const leaf = new RegExp(`^${context.variable}\\.\\w+$`).test(inner) && !isCopy(context.resultType) ? `${inner}.clone()` : inner
        const map = context.resultNullable ? 'and_then' : 'map'
        const owned = expr.startsWith('source.') ? `${expr}.as_ref()` : expr
        return `${owned}.${map}(|${context.variable}| ${leaf})`
      },
      wrapOptional: (expr) => `Some(${expr})`,
      unwrap: (expr) => `${expr}.expect("a required value is missing in the source")`,
      placeholder: (_type, field) => `todo!(${quote(`no value for ${field.name} in the mapping`)})`,
      expression: {
        binary: (operator, left, right) => (operator === '??' ? `${left}.unwrap_or(${right})` : `${left} ${operator} ${right}`),
        not: (value) => `!${value}`,
        conditional: (condition, then, otherwise) => `if ${condition} { ${then} } else { ${otherwise} }`,
        call: (name, args) => {
          const [a, b, c] = args
          switch (name) {
            case 'upper':
              return `${a}.to_uppercase()`
            case 'lower':
              return `${a}.to_lowercase()`
            case 'trim':
              return `${a}.trim().to_string()`
            case 'length':
              return `${a}.chars().count()`
            case 'concat':
              return `format!(${quote(args.map(() => '{}').join(''))}, ${args.join(', ')})`
            case 'substring':
              return c === undefined
                ? `${a}.chars().skip(${b} as usize).collect::<String>()`
                : `${a}.chars().skip(${b} as usize).take(${c} as usize).collect::<String>()`
            case 'replace':
              return `${a}.replace(${b}, ${c})`
            case 'round':
            case 'floor':
            case 'ceil':
            case 'abs':
              return `${a}.${name}()`
            case 'min':
            case 'max':
              return `${a}.${name}(${b})`
            case 'toString':
              return `${a}.to_string()`
            case 'toNumber':
              return `${a}.parse::<f64>().expect("not a number")`
          }
        },
      },
    }
  }

  /** A direct read of a field that is not `Copy` is cloned: the mapping borrows its source. */
  private owned(value: Value | null, code: string): string {
    if (!value) return code
    const plain = value.k === 'path' && !value.nullable
    if (plain && !isCopy(value.type)) return `${code}.clone()`
    if (value.k === 'path' && value.nullable && value.steps.length === 1 && !isCopy(value.type)) return `${code}.clone()`
    return code
  }

  implementation(mapper: MapperPlan): string {
    const roots = { source: 'source', item: 'item', depth: 0, lists: 0 }
    const lines: string[] = []
    for (const assignment of mapper.assignments) {
      let code = this.emitter.assignment(assignment, roots)
      const value = assignment.value
      if (code !== null && value && !assignment.unsafeNull && !assignment.missing) {
        const wrapped = code.startsWith('Some(') && (assignment.field.nullable || assignment.field.optional) && !value.nullable
        code = wrapped ? `Some(${this.owned(value, code.slice(5, -1))})` : this.owned(value, code)
      } else if (code !== null && value && assignment.unsafeNull) {
        const inner = code.replace(/\.expect\("a required value is missing in the source"\)$/, '')
        code = `${this.owned(value, inner)}.expect("a required value is missing in the source")`
      }
      // Struct literals need every field: an optional one without value is None
      lines.push(
        `${this.name(assignment.field, 'target')}: ${code ?? (assignment.field.nullable || assignment.field.optional ? 'None' : 'Default::default()')},`,
      )
    }
    const source = typeName(mapper.source.name)
    const target = typeName(mapper.target.name)
    return `impl From<&${source}> for ${target} {\n    fn from(source: &${source}) -> Self {\n        Self {\n${indent(lines.join('\n'), 12)}\n        }\n    }\n}`
  }
}

function generate(plan: Plan, settings: GenerateSettings): GeneratedCode {
  const writer = new RustWriter(plan, settings)
  const implementations = plan.mappers.map((mapper) => writer.implementation(mapper))
  const helpers = [...writer.helpers.values()].map((helper) => helper.code)
  const modelsPath = optionValue(rustGenerator, plan, settings, 'modelsPath')
  const models = new Set<string>()
  for (const mapper of plan.mappers) {
    models.add(typeName(mapper.source.name))
    models.add(typeName(mapper.target.name))
  }
  for (const enumDef of [...plan.enums.source, ...plan.enums.target]) models.add(typeName(enumDef.name))
  const uses = [...writer.uses].sort().map((item) => `use ${item};`)
  if (modelsPath) uses.push(`use ${modelsPath}::{${[...models].sort().join(', ')}};`)
  const code = `${[uses.join('\n'), ...implementations, ...helpers].filter((part) => part !== '').join('\n\n')}\n`
  return { files: [{ name: `${toSnakeCase(plan.root.source.name)}_mapping.rs`, code }], notes: writer.emitter.notes }
}

export const rustGenerator: CodeGenerator = {
  id: 'rust',
  label: 'Rust',
  editorLanguage: 'rust',
  modes: ['from'],
  options: [{ id: 'modelsPath', kind: 'text', choices: ['crate::models'] }],
  generate,
}
