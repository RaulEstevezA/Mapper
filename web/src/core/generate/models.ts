import { convertCase, toPascalCase, toScreamingSnakeCase, type NamingConvention } from '../model/naming.ts'
import {
  allFields,
  findEnum,
  findModel,
  modelOf,
  type EnumDef,
  type FieldDef,
  type ModelDef,
  type ModelSchema,
  type TypeRef,
} from '../model/schema.ts'
import type { InputFormatId } from '../parsers/types.ts'

/** Writes a new target model from the source one: the same fields in the conventions of the chosen
 * language, as text the user edits in the target editor. It is a starting point, not a mapping: once
 * written, the target is read back like any other input. */

export type DraftFormat = Extract<InputFormatId, 'typescript' | 'python' | 'kotlin' | 'java' | 'csharp' | 'jsonschema'>

export const DRAFT_FORMATS: readonly DraftFormat[] = ['typescript', 'python', 'kotlin', 'java', 'csharp', 'jsonschema']

// Suffixes that describe the source's role, not what it holds: UserDto, OrderResponse, AddressApi
const ROLE_SUFFIX = /(Dto|DTO|Response|Request|Api|API|Payload|Resource|Entity|Record|Model|Data|Json|Schema)$/

/** Name of the new model: the source name without its role suffix (`UserDto` → `User`). A generic name
 * (`Source`, read from a JSON document) becomes `Target`. */
export function draftName(name: string): string {
  if (name === 'Source' || name === 'Root') return 'Target'
  const stripped = name.replace(ROLE_SUFFIX, '')
  return toPascalCase(stripped === '' ? name : stripped) || 'Target'
}

interface Collected {
  models: ModelDef[]
  enums: EnumDef[]
  names: Map<string, string>
}

/** The root model and every model and enum it uses, nested ones first, with their new names. */
function collect(schema: ModelSchema, root: string): Collected {
  const models: ModelDef[] = []
  const enums: EnumDef[] = []
  const names = new Map<string, string>()
  const used = new Set<string>()
  const rename = (name: string) => {
    let candidate = draftName(name)
    for (let n = 2; used.has(candidate); n++) candidate = `${draftName(name)}${n}`
    used.add(candidate)
    names.set(name, candidate)
  }
  const visit = (name: string) => {
    if (names.has(name)) return
    const model = findModel(schema, name)
    if (!model) return
    rename(name)
    for (const field of allFields(schema, model)) {
      const enumName = enumOf(field.type)
      if (enumName && !names.has(enumName)) {
        const enumDef = findEnum(schema, enumName)
        if (enumDef) {
          rename(enumName)
          enums.push(enumDef)
        }
      }
      const nested = modelOf(field.type)
      if (nested) visit(nested)
    }
    models.push({ ...model, fields: allFields(schema, model) })
  }
  visit(root)
  return { models, enums, names }
}

function enumOf(type: TypeRef): string | null {
  if (type.kind === 'enum') return type.name
  if (type.kind === 'array') return enumOf(type.items)
  if (type.kind === 'map') return enumOf(type.value)
  return null
}

const isMissingAllowed = (field: FieldDef) => field.nullable || field.optional

interface Writer {
  convention: NamingConvention
  type: (type: TypeRef, names: Map<string, string>, boxed?: boolean) => string
  model: (name: string, model: ModelDef, fields: { name: string; field: FieldDef }[], names: Map<string, string>) => string
  enum: (name: string, enumDef: EnumDef) => string
  header?: (body: string) => string
}

const ref = (type: Extract<TypeRef, { kind: 'model' | 'enum' }>, names: Map<string, string>) => names.get(type.name) ?? draftName(type.name)

/** `/** text *\/` above a declaration, indented; nothing without text. */
const jsdoc = (text: string | undefined, indent = '') => (text ? `${indent}/** ${text} */\n` : '')

const WRITERS: Record<Exclude<DraftFormat, 'jsonschema'>, Writer> = {
  typescript: {
    convention: 'camelCase',
    type: (type, names) => {
      const write = (item: TypeRef): string => {
        switch (item.kind) {
          case 'primitive':
            return ['integer', 'float', 'decimal'].includes(item.name)
              ? 'number'
              : item.name === 'boolean'
                ? 'boolean'
                : ['date', 'datetime'].includes(item.name)
                  ? 'Date'
                  : item.name === 'any'
                    ? 'unknown'
                    : 'string'
          case 'array':
            return `${write(item.items)}[]`
          case 'map':
            return `Record<string, ${write(item.value)}>`
          case 'model':
          case 'enum':
            return ref(item, names)
          case 'unknown':
            return 'unknown'
        }
      }
      return write(type)
    },
    model: (name, model, fields, names) =>
      `${jsdoc(model.description)}export interface ${name} {\n${fields
        .map(
          ({ name: fieldName, field }) =>
            `${jsdoc(field.description, '  ')}  ${fieldName}${field.optional ? '?' : ''}: ${WRITERS.typescript.type(field.type, names)}${field.nullable ? ' | null' : ''}`,
        )
        .join('\n')}\n}`,
    enum: (name, enumDef) =>
      `export enum ${name} {\n${enumDef.values.map((value) => `  ${toPascalCase(value.name) || 'Value'} = ${JSON.stringify(String(value.value ?? value.name))},`).join('\n')}\n}`,
  },
  python: {
    convention: 'snake_case',
    type: (type, names) => {
      const write = (item: TypeRef): string => {
        switch (item.kind) {
          case 'primitive':
            return {
              string: 'str',
              integer: 'int',
              float: 'float',
              decimal: 'Decimal',
              boolean: 'bool',
              date: 'date',
              datetime: 'datetime',
              time: 'time',
              duration: 'timedelta',
              uuid: 'UUID',
              binary: 'bytes',
              any: 'Any',
            }[item.name]
          case 'array':
            return `list[${write(item.items)}]`
          case 'map':
            return `dict[str, ${write(item.value)}]`
          case 'model':
          case 'enum':
            return ref(item, names)
          case 'unknown':
            return 'Any'
        }
      }
      return write(type)
    },
    // Fields with a default go last: dataclasses do not allow a required field after an optional one
    model: (name, model, fields, names) => {
      const ordered = [...fields.filter(({ field }) => !isMissingAllowed(field)), ...fields.filter(({ field }) => isMissingAllowed(field))]
      const lines = ordered.map(
        ({ name: fieldName, field }) =>
          `    ${fieldName}: ${WRITERS.python.type(field.type, names)}${isMissingAllowed(field) ? ' | None = None' : ''}`,
      )
      return `@dataclass\nclass ${name}:\n${model.description ? `    """${model.description}"""\n\n` : ''}${lines.length > 0 ? lines.join('\n') : '    pass'}`
    },
    enum: (name, enumDef) =>
      `class ${name}(str, Enum):\n${enumDef.values.map((value) => `    ${toScreamingSnakeCase(value.name) || 'VALUE'} = ${JSON.stringify(String(value.value ?? value.name))}`).join('\n')}`,
    header: (body) => {
      const imports = ['from dataclasses import dataclass']
      const datetime = ['date', 'datetime', 'time', 'timedelta'].filter((name) => new RegExp(`: (.*\\W)?${name}\\b`).test(body))
      if (datetime.length > 0) imports.push(`from datetime import ${datetime.join(', ')}`)
      if (/\bDecimal\b/.test(body)) imports.push('from decimal import Decimal')
      if (/\(str, Enum\)/.test(body)) imports.push('from enum import Enum')
      if (/\bAny\b/.test(body)) imports.push('from typing import Any')
      if (/\bUUID\b/.test(body)) imports.push('from uuid import UUID')
      return `${imports.join('\n')}\n\n\n${body}`
    },
  },
  kotlin: {
    convention: 'camelCase',
    type: (type, names) => {
      const write = (item: TypeRef): string => {
        switch (item.kind) {
          case 'primitive':
            if (item.name === 'integer') return item.bits === 32 || item.bits === 16 || item.bits === 8 ? 'Int' : 'Long'
            return (
              {
                string: 'String',
                float: 'Double',
                decimal: 'BigDecimal',
                boolean: 'Boolean',
                date: 'LocalDate',
                datetime: 'Instant',
                time: 'LocalTime',
                duration: 'Duration',
                uuid: 'UUID',
                binary: 'ByteArray',
                any: 'Any',
              }[item.name] ?? 'Any'
            )
          case 'array':
            return `List<${write(item.items)}>`
          case 'map':
            return `Map<String, ${write(item.value)}>`
          case 'model':
          case 'enum':
            return ref(item, names)
          case 'unknown':
            return 'Any'
        }
      }
      return write(type)
    },
    model: (name, model, fields, names) =>
      `${jsdoc(model.description)}data class ${name}(\n${fields
        .map(
          ({ name: fieldName, field }) =>
            `    val ${fieldName}: ${WRITERS.kotlin.type(field.type, names)}${isMissingAllowed(field) ? '? = null' : ''},`,
        )
        .join('\n')}\n)`,
    enum: (name, enumDef) =>
      `enum class ${name} { ${enumDef.values.map((value) => toScreamingSnakeCase(value.name) || 'VALUE').join(', ')} }`,
    header: (body) => {
      const imports = [
        ['BigDecimal', 'java.math.BigDecimal'],
        ['Duration', 'java.time.Duration'],
        ['Instant', 'java.time.Instant'],
        ['LocalDate', 'java.time.LocalDate'],
        ['LocalTime', 'java.time.LocalTime'],
        ['UUID', 'java.util.UUID'],
      ].filter(([name]) => new RegExp(`\\b${name}\\b`).test(body))
      return imports.length > 0 ? `${imports.map(([, path]) => `import ${path}`).join('\n')}\n\n${body}` : body
    },
  },
  java: {
    convention: 'camelCase',
    type: (type, names, boxed = false) => {
      const write = (item: TypeRef, box: boolean): string => {
        switch (item.kind) {
          case 'primitive':
            if (item.name === 'integer')
              return item.bits === 32 || item.bits === 16 || item.bits === 8 ? (box ? 'Integer' : 'int') : box ? 'Long' : 'long'
            if (item.name === 'float') return box ? 'Double' : 'double'
            if (item.name === 'boolean') return box ? 'Boolean' : 'boolean'
            return (
              {
                string: 'String',
                decimal: 'BigDecimal',
                date: 'LocalDate',
                datetime: 'OffsetDateTime',
                time: 'LocalTime',
                duration: 'Duration',
                uuid: 'UUID',
                binary: 'byte[]',
                any: 'Object',
              }[item.name] ?? 'Object'
            )
          case 'array':
            return `List<${write(item.items, true)}>`
          case 'map':
            return `Map<String, ${write(item.value, true)}>`
          case 'model':
          case 'enum':
            return ref(item, names)
          case 'unknown':
            return 'Object'
        }
      }
      return write(type, boxed)
    },
    // A record per model: fields that may be missing use boxed types, so they can be null
    model: (name, model, fields, names) =>
      `${jsdoc(model.description)}public record ${name}(\n${fields
        .map(({ name: fieldName, field }) => `        ${WRITERS.java.type(field.type, names, isMissingAllowed(field))} ${fieldName}`)
        .join(',\n')}\n) {\n}`,
    enum: (name, enumDef) =>
      `public enum ${name} {\n    ${enumDef.values.map((value) => toScreamingSnakeCase(value.name) || 'VALUE').join(',\n    ')}\n}`,
    header: (body) => {
      const imports = [
        ['BigDecimal', 'java.math.BigDecimal'],
        ['Duration', 'java.time.Duration'],
        ['LocalDate', 'java.time.LocalDate'],
        ['LocalTime', 'java.time.LocalTime'],
        ['OffsetDateTime', 'java.time.OffsetDateTime'],
        ['List', 'java.util.List'],
        ['Map', 'java.util.Map'],
        ['UUID', 'java.util.UUID'],
      ].filter(([name]) => new RegExp(`\\b${name}\\b`).test(body))
      return imports.length > 0 ? `${imports.map(([, path]) => `import ${path};`).join('\n')}\n\n${body}` : body
    },
  },
  csharp: {
    convention: 'PascalCase',
    type: (type, names) => {
      const write = (item: TypeRef): string => {
        switch (item.kind) {
          case 'primitive':
            if (item.name === 'integer') return item.bits === 32 || item.bits === 16 || item.bits === 8 ? 'int' : 'long'
            return (
              {
                string: 'string',
                float: 'double',
                decimal: 'decimal',
                boolean: 'bool',
                date: 'DateOnly',
                datetime: 'DateTime',
                time: 'TimeOnly',
                duration: 'TimeSpan',
                uuid: 'Guid',
                binary: 'byte[]',
                any: 'object',
              }[item.name] ?? 'object'
            )
          case 'array':
            return `List<${write(item.items)}>`
          case 'map':
            return `Dictionary<string, ${write(item.value)}>`
          case 'model':
          case 'enum':
            return ref(item, names)
          case 'unknown':
            return 'object'
        }
      }
      return write(type)
    },
    // `required` for values that must be given; nullable types for the rest
    model: (name, model, fields, names) =>
      `${model.description ? `/// <summary>${model.description}</summary>\n` : ''}public class ${name}\n{\n${fields
        .map(
          ({ name: fieldName, field }) =>
            `    public ${isMissingAllowed(field) ? '' : 'required '}${WRITERS.csharp.type(field.type, names)}${isMissingAllowed(field) ? '?' : ''} ${fieldName} { get; set; }`,
        )
        .join('\n')}\n}`,
    enum: (name, enumDef) =>
      `public enum ${name}\n{\n    ${enumDef.values.map((value) => toPascalCase(value.name) || 'Value').join(',\n    ')}\n}`,
  },
}

function fieldNames(model: ModelDef, convention: NamingConvention): { name: string; field: FieldDef }[] {
  const used = new Set<string>()
  return model.fields.map((field) => {
    let name = convertCase(field.name, convention) || 'field'
    if (/^\d/.test(name)) name = `_${name}`
    for (let n = 2; used.has(name); n++) name = `${convertCase(field.name, convention)}${n}`
    used.add(name)
    return { name, field }
  })
}

function jsonSchemaType(type: TypeRef, names: Map<string, string>, nullable: boolean): Record<string, unknown> {
  const write = (item: TypeRef): Record<string, unknown> => {
    switch (item.kind) {
      case 'primitive': {
        const formats: Record<string, Record<string, unknown>> = {
          string: { type: 'string' },
          integer: item.bits === 32 ? { type: 'integer', format: 'int32' } : { type: 'integer' },
          float: { type: 'number' },
          decimal: { type: 'number' },
          boolean: { type: 'boolean' },
          date: { type: 'string', format: 'date' },
          datetime: { type: 'string', format: 'date-time' },
          time: { type: 'string', format: 'time' },
          duration: { type: 'string', format: 'duration' },
          uuid: { type: 'string', format: 'uuid' },
          binary: { type: 'string', contentEncoding: 'base64' },
          any: {},
        }
        return formats[item.name]
      }
      case 'array':
        return { type: 'array', items: write(item.items) }
      case 'map':
        return { type: 'object', additionalProperties: write(item.value) }
      case 'model':
      case 'enum':
        return { $ref: `#/$defs/${ref(item, names)}` }
      case 'unknown':
        return {}
    }
  }
  const schema = write(type)
  if (!nullable) return schema
  if (typeof schema.type === 'string') return { ...schema, type: [schema.type, 'null'] }
  return { oneOf: [schema, { type: 'null' }] }
}

function writeJsonSchema(collected: Collected, root: string): string {
  const objectSchema = (model: ModelDef) => {
    const fields = fieldNames(model, 'camelCase')
    const properties = Object.fromEntries(
      fields.map(({ name, field }) => [
        name,
        {
          ...jsonSchemaType(field.type, collected.names, field.nullable),
          ...(field.description ? { description: field.description } : {}),
        },
      ]),
    )
    const required = fields.filter(({ field }) => !field.optional).map(({ name }) => name)
    return {
      type: 'object',
      ...(model.description ? { description: model.description } : {}),
      properties,
      ...(required.length > 0 ? { required } : {}),
    }
  }
  const rootModel = collected.models.find((model) => model.name === root)!
  const defs: Record<string, unknown> = {}
  for (const enumDef of collected.enums)
    defs[collected.names.get(enumDef.name)!] = { enum: enumDef.values.map((value) => value.value ?? value.name) }
  for (const model of collected.models) if (model !== rootModel) defs[collected.names.get(model.name)!] = objectSchema(model)
  const document = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: collected.names.get(root),
    ...objectSchema(rootModel),
    ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/** The new target model as text in the chosen format, and the name of its root model. */
export function draftTarget(source: ModelSchema, root: string, format: DraftFormat): { text: string; model: string } | null {
  if (!findModel(source, root)) return null
  const collected = collect(source, root)
  const model = collected.names.get(root)!
  if (format === 'jsonschema') return { text: writeJsonSchema(collected, root), model }
  const writer = WRITERS[format]
  const blocks = [
    ...collected.enums.map((enumDef) => writer.enum(collected.names.get(enumDef.name)!, enumDef)),
    ...collected.models.map((item) =>
      writer.model(collected.names.get(item.name)!, item, fieldNames(item, writer.convention), collected.names),
    ),
  ]
  const separator = format === 'python' ? '\n\n\n' : '\n\n'
  const body = blocks.join(separator)
  return { text: `${writer.header ? writer.header(body) : body}\n`, model }
}
