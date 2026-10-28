import { expect } from 'vitest'
import { describeType, findModel, type ModelSchema } from '../../model/schema.ts'
import { parseInput } from '../registry.ts'
import type { InputFormatId, ParseOptions } from '../types.ts'

/** Parses and fails the test with the error when the input is not valid. */
export function parseOk(text: string, format: InputFormatId, options?: ParseOptions) {
  const outcome = parseInput(text, format, options)
  if (!outcome.ok) throw new Error(`Expected ${format} to parse: ${JSON.stringify(outcome.error)}`)
  return outcome
}

/** Fields of a model as `name: type` lines, with `?` when optional and `| null` when nullable. */
export function fieldsOf(schema: ModelSchema, model: string): string[] {
  const found = findModel(schema, model)
  expect(found, `model ${model} in ${schema.models.map((item) => item.name).join(', ')}`).toBeDefined()
  return found!.fields.map(
    (field) => `${field.name}${field.optional ? '?' : ''}: ${describeType(field.type)}${field.nullable ? ' | null' : ''}`,
  )
}
