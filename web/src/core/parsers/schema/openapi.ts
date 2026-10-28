import { failure, type InputParser } from '../types.ts'
import { convertSchemas, readStructured } from './jsonSchema.ts'

/** The models of an OpenAPI 3 (`components.schemas`) or Swagger 2 (`definitions`) document. */
export const openApiParser: InputParser = {
  id: 'openapi',
  kind: 'schema',
  label: 'OpenAPI / Swagger',
  extensions: [],
  editorLanguage: 'yaml',
  detect(text) {
    return /^\s*["']?(openapi|swagger)["']?\s*:\s*["']?[23]\./m.test(text.slice(0, 2000)) ? 0.99 : 0
  },
  parse(text) {
    const read = readStructured(text)
    if (!read.ok) return read.outcome
    const document = read.value
    if (typeof document !== 'object' || document === null) return failure('noModels')
    const record = document as Record<string, unknown>
    const components = record.components as Record<string, unknown> | undefined
    const { schema, warnings } = convertSchemas(
      [
        { prefix: '#/components/schemas/', schemas: components?.schemas },
        { prefix: '#/definitions/', schemas: record.definitions },
      ],
      null,
      'Root',
      'openapi',
    )
    if (schema.models.length === 0) return failure('noModels')
    return { ok: true, schema, warnings }
  },
}
