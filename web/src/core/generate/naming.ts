import { convertCase, toPascalCase, type NamingConvention } from '../model/naming.ts'
import type { FieldDef, ModelSchema } from '../model/schema.ts'
import type { NamingMode } from './types.ts'

// Formats whose names are keys of a document (JSON, YAML…), not names written in code
const DATA_FORMATS = new Set(['json', 'yaml', 'xml', 'csv', 'jsonschema', 'openapi', 'modelschema', 'graphql', 'protobuf', 'prisma'])

export interface NamingRules {
  language: string
  convention: NamingConvention
  reserved: ReadonlySet<string>
  /** How a reserved word is made usable (`class_`, `` `class` ``, `@class`, `r#type`) */
  escape: (name: string) => string
  /** Plain objects keep document keys as they are (TypeScript, JavaScript, Python dicts) */
  rawObjects?: boolean
  /** Go writes initialisms in capitals: `ID`, `URL` */
  initialisms?: boolean
}

const VALID_IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u
const INITIALISMS = [
  'Id',
  'Url',
  'Uri',
  'Api',
  'Http',
  'Https',
  'Json',
  'Xml',
  'Sql',
  'Uuid',
  'Html',
  'Ip',
  'Tcp',
  'Udp',
  'Css',
  'Dns',
  'Cpu',
  'Ui',
]

function goInitialisms(name: string): string {
  // UserId → UserID, ApiUrl → APIURL: each capitalized initialism ends where the next word starts
  return name.replace(new RegExp(`(${INITIALISMS.join('|')})(?=[A-Z0-9]|$)`, 'g'), (word) => word.toUpperCase())
}

/** Whether names of a schema are used as they are in this language. */
export function keepsNames(schema: ModelSchema, rules: NamingRules, mode: NamingMode): boolean {
  if (mode === 'keep') return true
  if (mode === 'convention') return false
  const origin = schema.origin
  if (origin?.language === rules.language) return true
  // A JavaScript program reads JSON as objects with the same keys
  if (rules.rawObjects && origin && DATA_FORMATS.has(origin.format)) return true
  if (
    rules.rawObjects &&
    (origin?.language === 'typescript' || origin?.language === 'javascript') &&
    (rules.language === 'typescript' || rules.language === 'javascript')
  )
    return true
  return false
}

/** A name in the language's convention, usable as an identifier. */
export function conventionalName(name: string, rules: NamingRules): string {
  let result = convertCase(name, rules.convention) || 'field'
  if (rules.initialisms) result = goInitialisms(result)
  if (/^\p{N}/u.test(result)) result = `_${result}`
  return rules.reserved.has(result) ? rules.escape(result) : result
}

/** Name of a field in the generated code. */
export function fieldName(field: FieldDef, schema: ModelSchema, rules: NamingRules, mode: NamingMode): string {
  const name = field.name
  if (keepsNames(schema, rules, mode) && (VALID_IDENTIFIER.test(name) || rules.rawObjects)) {
    return rules.reserved.has(name) && !rules.rawObjects ? rules.escape(name) : name
  }
  return conventionalName(name, rules)
}

/** A type name usable in code (model names are kept; data formats may give odd ones). */
export function typeName(name: string): string {
  return VALID_IDENTIFIER.test(name) ? name : toPascalCase(name) || 'Model'
}

export function isValidIdentifier(name: string): boolean {
  return VALID_IDENTIFIER.test(name)
}
