import { pruneMappings } from '../mapping/edit.ts'
import type { MappingSet } from '../mapping/types.ts'
import type { ModelSchema } from '../model/schema.ts'
import { validateModelSchema } from '../parsers/schema/modelSchema.ts'
import type { InputFormatId } from '../parsers/types.ts'
import type { NamingMode } from '../generate/types.ts'

/** A saved Mapper project: both inputs as written, their models, the mapping and the output settings,
 * so work can continue later or on another computer (docs/interoperability.md). */

export const PROJECT_FORMAT = 'mapper-project'
export const PROJECT_VERSION = 1

export interface ProjectSide {
  format: InputFormatId
  text: string
  /** Model chosen on this side */
  model: string
  /** The models as they were read, so the mapping still matches them even if the text no longer parses */
  schema: ModelSchema
}

export interface OutputSettings {
  generator: string
  mode: string
  naming: NamingMode
  options: Record<string, Record<string, string>>
}

export interface MapperProject {
  format: typeof PROJECT_FORMAT
  version: typeof PROJECT_VERSION
  /** ISO date of the save, for display */
  savedAt: string
  source: ProjectSide
  target: ProjectSide
  mapping: MappingSet
  output: OutputSettings
}

export function createProject(
  source: ProjectSide,
  target: ProjectSide,
  mapping: MappingSet,
  output: OutputSettings,
  now = new Date(),
): MapperProject {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: now.toISOString(),
    source,
    target,
    mapping: pruneMappings(mapping),
    output,
  }
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

const TRANSFORMS = new Set([
  'direct',
  'concat',
  'split',
  'constant',
  'boolean',
  'enum',
  'epoch',
  'arithmetic',
  'object',
  'collection',
  'expression',
])
const STATUSES = new Set(['active', 'pending', 'ignored', 'unmapped'])

function validateMappingSet(value: unknown, path: string): string | null {
  if (!isObject(value) || typeof value.root !== 'string' || !Array.isArray(value.mappings)) return path
  const ids = new Set<string>()
  for (const [index, mapping] of value.mappings.entries()) {
    const at = `${path}.mappings[${index}]`
    if (
      !isObject(mapping) ||
      typeof mapping.id !== 'string' ||
      typeof mapping.source !== 'string' ||
      typeof mapping.target !== 'string' ||
      !Array.isArray(mapping.fields)
    )
      return at
    if (!isStringArray(mapping.ignoredSources ?? [])) return `${at}.ignoredSources`
    ids.add(mapping.id)
    for (const [fieldIndex, field] of mapping.fields.entries()) {
      const fieldPath = `${at}.fields[${fieldIndex}]`
      if (!isObject(field) || typeof field.target !== 'string') return fieldPath
      if (!Array.isArray(field.sources) || !field.sources.every(isStringArray)) return `${fieldPath}.sources`
      if (!isObject(field.transform) || !TRANSFORMS.has(String(field.transform.kind))) return `${fieldPath}.transform`
      if (!STATUSES.has(String(field.status))) return `${fieldPath}.status`
      if (field.transform.kind === 'expression' && typeof field.transform.expression !== 'string') return `${fieldPath}.transform`
    }
  }
  if (!ids.has(value.root)) return `${path}.root`
  return null
}

function validateSide(value: unknown, path: string): string | null {
  if (!isObject(value) || typeof value.format !== 'string' || typeof value.text !== 'string' || typeof value.model !== 'string') return path
  const schema = validateModelSchema(value.schema)
  if (!schema.ok) return `${path}.schema${schema.path.slice(1)}`
  return null
}

export type ProjectReadResult =
  { ok: true; project: MapperProject } | { ok: false; error: 'notJson' | 'notProject' | 'newerVersion' | 'invalid'; path?: string }

/** Reads a project file. Everything is checked: a damaged or edited file is rejected with the path of the
 * first problem instead of breaking the page later. */
export function readProject(text: string): ProjectReadResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, error: 'notJson' }
  }
  if (!isObject(value) || value.format !== PROJECT_FORMAT) return { ok: false, error: 'notProject' }
  if (typeof value.version !== 'number' || value.version > PROJECT_VERSION) return { ok: false, error: 'newerVersion' }
  for (const [key, check] of [
    ['source', validateSide],
    ['target', validateSide],
    ['mapping', validateMappingSet],
  ] as const) {
    const problem = check(value[key], `$.${key}`)
    if (problem) return { ok: false, error: 'invalid', path: problem }
  }
  const output = value.output
  if (!isObject(output) || typeof output.generator !== 'string' || typeof output.mode !== 'string')
    return { ok: false, error: 'invalid', path: '$.output' }
  const project = value as unknown as MapperProject
  return {
    ok: true,
    project: {
      ...project,
      output: {
        ...project.output,
        naming: ['auto', 'keep', 'convention'].includes(project.output.naming) ? project.output.naming : 'auto',
        options: isObject(output.options) ? project.output.options : {},
      },
    },
  }
}

export function projectFileName(project: MapperProject): string {
  const base = `${project.source.model}-to-${project.target.model}`.replace(/[^\w.-]+/g, '-').toLowerCase()
  return `${base}.mapper.json`
}
