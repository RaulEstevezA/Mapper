import type { ModelSchema } from '../model/schema.ts'
import { validateModelSchema } from '../parsers/schema/modelSchema.ts'

/** Passing a model between the tools of the family (Api2Class → Mapper → DBCreate) without a server.
 * The contract is documented in docs/interoperability.md; other tools implement the same few lines. */

export const HANDOFF_FORMAT = 'model-handoff'
export const HANDOFF_VERSION = 1

/** Tools that may send or receive models. */
export type ToolId = 'api2class' | 'mapper' | 'dbcreate' | 'datacleanr'

export interface Handoff {
  format: typeof HANDOFF_FORMAT
  version: typeof HANDOFF_VERSION
  from: ToolId
  /** Which side of the mapping it fills, for Mapper; other tools ignore it */
  role: 'source' | 'target'
  /** The model to open, and its name in the schema */
  schema: ModelSchema
  model?: string
  /** Text to show in the input editor (the JSON the model came from, the generated code); optional */
  text?: { format: string; content: string }
}

/** Key in sessionStorage of the receiving tool: `mapper.incoming`, `dbcreate.incoming`. */
export function incomingKey(tool: ToolId): string {
  return `${tool}.incoming`
}

// Far above any model, and small enough for sessionStorage
export const MAX_HANDOFF_SIZE = 4 * 1024 * 1024

const TOOLS: readonly ToolId[] = ['api2class', 'mapper', 'dbcreate', 'datacleanr']

/** Checks a received handoff. Anything unexpected is rejected: the content comes from outside the page. */
export function readHandoff(value: unknown): Handoff | null {
  if (typeof value === 'string') {
    if (value.length > MAX_HANDOFF_SIZE) return null
    try {
      return readHandoff(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (typeof value !== 'object' || value === null) return null
  const handoff = value as Record<string, unknown>
  if (handoff.format !== HANDOFF_FORMAT || handoff.version !== HANDOFF_VERSION) return null
  if (!TOOLS.includes(handoff.from as ToolId) || (handoff.role !== 'source' && handoff.role !== 'target')) return null
  const schema = validateModelSchema(handoff.schema)
  if (!schema.ok) return null
  const result: Handoff = {
    format: HANDOFF_FORMAT,
    version: HANDOFF_VERSION,
    from: handoff.from as ToolId,
    role: handoff.role,
    schema: schema.schema,
  }
  if (typeof handoff.model === 'string' && schema.schema.models.some((model) => model.name === handoff.model)) result.model = handoff.model
  const text = handoff.text as Record<string, unknown> | undefined
  if (text && typeof text.format === 'string' && typeof text.content === 'string' && text.content.length <= MAX_HANDOFF_SIZE)
    result.text = { format: text.format, content: text.content }
  return result
}

export function createHandoff(from: ToolId, role: 'source' | 'target', schema: ModelSchema, model?: string): Handoff {
  return { format: HANDOFF_FORMAT, version: HANDOFF_VERSION, from, role, schema, ...(model ? { model } : {}) }
}

/** Takes the handoff left for this tool in sessionStorage, once: it is removed as soon as it is read. */
export function takeIncoming(storage: Pick<Storage, 'getItem' | 'removeItem'>, tool: ToolId = 'mapper'): Handoff | null {
  try {
    const raw = storage.getItem(incomingKey(tool))
    if (raw === null) return null
    storage.removeItem(incomingKey(tool))
    return readHandoff(raw)
  } catch {
    return null
  }
}

/** Origins allowed to send models with postMessage: the portfolio, where every tool is published, and
 * the local development server. */
export function isTrustedOrigin(origin: string, own: string): boolean {
  return origin === own || origin === 'https://raulesteveza.github.io'
}
