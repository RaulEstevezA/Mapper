import { suggestMapping } from '../core/matching/engine.ts'
import { resolvePath } from '../core/mapping/paths.ts'
import { findMapping, pathKey, type FieldMapping, type MappingSet, type ModelMapping } from '../core/mapping/types.ts'
import type { Diagnostic } from '../core/mapping/validate.ts'
import { allFields, defaultRoot, findModel, type ModelSchema } from '../core/model/schema.ts'
import { detectFormat, parseInput } from '../core/parsers/registry.ts'
import type { InputFormatId, ParseOutcome } from '../core/parsers/types.ts'

/** Workspace logic that the interface uses, kept out of the components so it can be tested. */

export interface InputState {
  text: string
  /** null: detected from the text */
  format: InputFormatId | null
  /** null: the default model of the schema */
  model: string | null
  /** File name it was opened from, for detection and display */
  fileName?: string
  /** Where it came from when another tool sent it */
  receivedFrom?: string
}

export const EMPTY_INPUT: InputState = { text: '', format: null, model: null }

export interface ReadInput {
  format: InputFormatId | null
  outcome: ParseOutcome | null
  /** Model used: the chosen one when it exists, the default otherwise */
  model: string | null
}

/** Parses an input with its chosen or detected format. */
export function readInput(input: InputState, role: 'source' | 'target'): ReadInput {
  if (input.text.trim() === '') return { format: input.format, outcome: null, model: null }
  const format = input.format ?? detectFormat(input.text, input.fileName)
  if (!format) return { format: null, outcome: null, model: null }
  const outcome = parseInput(input.text, format, { rootName: role === 'source' ? 'Source' : 'Target' })
  if (!outcome.ok) return { format, outcome, model: null }
  const chosen = input.model && findModel(outcome.schema, input.model) ? input.model : null
  return { format, outcome, model: chosen ?? defaultRoot(outcome.schema) ?? null }
}

/** A manual decision still makes sense when its target field exists and its sources are still there. */
function stillValid(field: FieldMapping, mapping: ModelMapping, source: ModelSchema, target: ModelSchema): boolean {
  const targetModel = findModel(target, mapping.target)
  if (!targetModel || !allFields(target, targetModel).some((item) => item.name === field.target)) return false
  return field.sources.every((path) => resolvePath(source, mapping.source, path) !== null)
}

/** New suggestions for the models, keeping what the user decided on the previous mapping (manual
 * choices, ignored fields, accepted reviews) wherever it still applies. */
export function reconcile(
  previous: MappingSet | null,
  source: ModelSchema,
  sourceModel: string,
  target: ModelSchema,
  targetModel: string,
): MappingSet {
  const fresh = suggestMapping(source, sourceModel, target, targetModel)
  if (!previous) return fresh
  const mappings = fresh.mappings.map((mapping) => {
    const old = findMapping(previous, mapping.id)
    if (!old) return mapping
    const fields = mapping.fields.map((field) => {
      const kept = old.fields.find((item) => item.target === field.target)
      if (!kept || !(kept.manual || (kept.status === 'active' && field.status === 'pending'))) return field
      if (!stillValid(kept, mapping, source, target)) return field
      // Object and list mappings keep their nested mapping only if it is still part of the set
      const nested = kept.transform.kind === 'object' || kept.transform.kind === 'collection' ? kept.transform.mapping : undefined
      if (nested && !fresh.mappings.some((item) => item.id === nested) && !previous.mappings.some((item) => item.id === nested))
        return field
      return { ...kept, candidates: field.candidates }
    })
    return {
      ...mapping,
      fields,
      ignoredSources: old.ignoredSources.filter((path) => resolvePath(source, mapping.source, path.split('.')) !== null),
    }
  })
  // Nested mappings the kept decisions use, carried over from the previous set
  const ids = new Set(mappings.map((mapping) => mapping.id))
  for (const mapping of mappings) {
    for (const field of mapping.fields) {
      const nested = field.transform.kind === 'object' || field.transform.kind === 'collection' ? field.transform.mapping : undefined
      if (nested && !ids.has(nested)) {
        const carried = findMapping(previous, nested)
        if (carried) {
          mappings.push(carried)
          ids.add(nested)
        }
      }
    }
  }
  return { root: fresh.root, mappings }
}

export type FieldCategory = 'mapped' | 'review' | 'conflict' | 'unmapped' | 'ignored'

export function categoryOf(field: FieldMapping): FieldCategory {
  if (field.status === 'ignored') return 'ignored'
  if (field.status === 'active') return 'mapped'
  if (field.status === 'pending') return field.confidence === 'conflict' ? 'conflict' : 'review'
  return 'unmapped'
}

export interface Summary {
  total: number
  mapped: number
  review: number
  conflict: number
  unmapped: number
  ignored: number
}

/** Counts of the fields of every model mapping reachable from the root. */
export function summarize(set: MappingSet | null): Summary {
  const summary: Summary = { total: 0, mapped: 0, review: 0, conflict: 0, unmapped: 0, ignored: 0 }
  for (const mapping of reachable(set)) {
    for (const field of mapping.fields) {
      summary.total++
      summary[categoryOf(field)]++
    }
  }
  return summary
}

/** Model mappings in the order they are shown: the root, then the nested ones as they are used. */
export function reachable(set: MappingSet | null): ModelMapping[] {
  if (!set) return []
  const result: ModelMapping[] = []
  const queue = [set.root]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const mapping = findMapping(set, id)
    if (!mapping) continue
    result.push(mapping)
    for (const field of mapping.fields) {
      if (field.status !== 'active' && field.status !== 'pending') continue
      if ((field.transform.kind === 'object' || field.transform.kind === 'collection') && field.transform.mapping)
        queue.push(field.transform.mapping)
    }
  }
  return result
}

export type Filter = 'all' | 'mapped' | 'review' | 'unmapped' | 'warnings'

/** Whether a field is shown with the current filter and search text. */
export function matchesFilter(field: FieldMapping, filter: Filter, search: string, diagnostics: Diagnostic[], mappingId: string): boolean {
  const category = categoryOf(field)
  if (filter === 'mapped' && category !== 'mapped') return false
  if (filter === 'review' && category !== 'review' && category !== 'conflict') return false
  if (filter === 'unmapped' && category !== 'unmapped' && category !== 'ignored') return false
  if (
    filter === 'warnings' &&
    !diagnostics.some((item) => item.mapping === mappingId && item.target === field.target && item.severity !== 'info')
  )
    return false
  const text = search.trim().toLowerCase()
  if (text === '') return true
  return field.target.toLowerCase().includes(text) || field.sources.some((path) => pathKey(path).toLowerCase().includes(text))
}
