import { failure, type InputParser } from '../types.ts'
import { inferSchema } from './infer.ts'
import { parseJson, type JsonValue } from './jsonText.ts'

/** A JSON document used as an example of the model: an API response, a message, a saved record. */
export const jsonParser: InputParser = {
  id: 'json',
  kind: 'data',
  label: 'JSON',
  extensions: ['.json'],
  editorLanguage: 'json',
  detect(text) {
    const start = text.trimStart()[0]
    return start === '{' || start === '[' ? 0.8 : 0
  },
  parse(text, options = {}) {
    const result = parseJson(text)
    if (!result.ok) {
      const { code, line, column, found, expected, key } = result.error
      if (code === 'empty') return failure('empty')
      const params: Record<string, string> = { detail: `json.${code}` }
      if (found !== undefined) params.found = found
      if (expected) params.expected = expected
      if (key !== undefined) params.key = key
      return failure('syntax', { line, column }, params)
    }
    return fromDataValue(result.value, options.rootName ?? 'Root', 'json')
  },
}

export function fromDataValue(value: JsonValue, rootName: string, format: string) {
  const inferred = inferSchema(value, rootName, format)
  if (!inferred) return failure('noModels')
  return { ok: true as const, schema: inferred.schema, warnings: inferred.warnings }
}
