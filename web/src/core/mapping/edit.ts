import { defaultTransform, resuggestMapping } from '../matching/engine.ts'
import type { Literal, ModelSchema } from '../model/schema.ts'
import { parseExpression } from '../transform/expression.ts'
import { findMapping, pathKey, type Candidate, type FieldMapping, type MappingSet, type SourcePath, type Transform } from './types.ts'

/** Every change the user can make to a mapping, as pure functions: they return a new set and never
 * modify the given one, so the interface can keep an undo history of plain values. */

function updateField(set: MappingSet, id: string, target: string, change: (field: FieldMapping) => FieldMapping): MappingSet {
  return {
    root: set.root,
    mappings: set.mappings.map((mapping) =>
      mapping.id !== id
        ? mapping
        : { ...mapping, fields: mapping.fields.map((field) => (field.target === target ? change(field) : field)) },
    ),
  }
}

/** Uses these sources for a target field, with the transformation their types need. */
export function chooseSources(
  set: MappingSet,
  source: ModelSchema,
  target: ModelSchema,
  id: string,
  targetField: string,
  sources: SourcePath[],
): MappingSet {
  const { set: withNested, transform } = defaultTransform(set, source, target, id, targetField, sources)
  return updateField(withNested, id, targetField, (field) => ({ ...field, sources, transform, status: 'active', manual: true }))
}

/** Applies one of the engine's suggestions (the first one by default). */
export function acceptCandidate(set: MappingSet, id: string, targetField: string, index = 0): MappingSet {
  return updateField(set, id, targetField, (field) => {
    const candidate: Candidate | undefined = field.candidates?.[index]
    if (!candidate) return field.sources.length > 0 || field.transform.kind === 'constant' ? { ...field, status: 'active' } : field
    return {
      ...field,
      sources: candidate.sources,
      transform: candidate.transform,
      reasons: candidate.reasons,
      status: 'active',
      // The user decided: a confirmed conflict is no longer one
      confidence: candidate.confidence === 'conflict' ? 'review' : candidate.confidence,
      manual: index > 0 || field.confidence === 'conflict' || field.status === 'pending',
    }
  })
}

/** Discards the suggestion: the field is left without value until the user chooses one. */
export function rejectSuggestion(set: MappingSet, id: string, targetField: string): MappingSet {
  return updateField(set, id, targetField, (field) => ({
    ...field,
    sources: [],
    transform: { kind: 'direct' },
    status: 'unmapped',
    manual: true,
  }))
}

/** The target field intentionally gets no value. */
export function ignoreTarget(set: MappingSet, id: string, targetField: string): MappingSet {
  return updateField(set, id, targetField, (field) => ({ ...field, status: 'ignored', manual: true }))
}

export function setTransform(set: MappingSet, id: string, targetField: string, transform: Transform): MappingSet {
  return updateField(set, id, targetField, (field) => ({
    ...field,
    transform,
    // A constant needs no source; an expression names its own
    sources: transform.kind === 'constant' ? [] : field.sources,
    status: 'active',
    manual: true,
  }))
}

/** Value used when the source is null or missing; undefined removes it. */
export function setFallback(set: MappingSet, id: string, targetField: string, fallback: Literal | undefined): MappingSet {
  return updateField(set, id, targetField, (field) => {
    const next = { ...field, manual: true }
    if (fallback === undefined) delete next.fallback
    else next.fallback = fallback
    return next
  })
}

/** Back to what the engine suggests for this field, undoing the user's changes to it. */
export function resetField(set: MappingSet, source: ModelSchema, target: ModelSchema, id: string, targetField: string): MappingSet {
  const fresh = resuggestMapping(set, id, source, target)
  const suggested = findMapping(fresh, id)?.fields.find((field) => field.target === targetField)
  if (!suggested) return set
  const reset = updateField(set, id, targetField, () => suggested)
  // Nested mappings the suggestion needs
  const known = new Set(reset.mappings.map((mapping) => mapping.id))
  return { root: reset.root, mappings: [...reset.mappings, ...fresh.mappings.filter((mapping) => !known.has(mapping.id))] }
}

/** Every field of a model mapping back to the engine's suggestions. */
export function restoreSuggestions(set: MappingSet, source: ModelSchema, target: ModelSchema, id: string): MappingSet {
  return resuggestMapping(set, id, source, target)
}

/** Marks a source field as intentionally unused, or not. */
export function toggleIgnoredSource(set: MappingSet, id: string, path: SourcePath): MappingSet {
  const key = pathKey(path)
  return {
    root: set.root,
    mappings: set.mappings.map((mapping) =>
      mapping.id !== id
        ? mapping
        : {
            ...mapping,
            ignoredSources: mapping.ignoredSources.includes(key)
              ? mapping.ignoredSources.filter((item) => item !== key)
              : [...mapping.ignoredSources, key],
          },
    ),
  }
}

/** Accepts every suggestion of a mapping that is waiting for review, except conflicts (they need a choice). */
export function acceptAllReviews(set: MappingSet, id: string): MappingSet {
  const mapping = findMapping(set, id)
  if (!mapping) return set
  return mapping.fields
    .filter((field) => field.status === 'pending' && field.confidence !== 'conflict')
    .reduce((current, field) => acceptCandidate(current, id, field.target), set)
}

/** Mappings no field or suggestion leads to any more, removed (before saving). */
export function pruneMappings(set: MappingSet): MappingSet {
  const reachable = new Set<string>()
  const queue = [set.root]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const field of findMapping(set, id)?.fields ?? []) {
      // Suggestions not accepted yet keep their nested mappings, so accepting them later still works
      for (const transform of [field.transform, ...(field.candidates ?? []).map((candidate) => candidate.transform)]) {
        if ((transform.kind === 'object' || transform.kind === 'collection') && transform.mapping) queue.push(transform.mapping)
      }
    }
  }
  return { root: set.root, mappings: set.mappings.filter((mapping) => reachable.has(mapping.id)) }
}

/** A custom expression: the fields it reads become the sources of the relation, so unused source fields
 * are still found. An expression that does not parse keeps the previous sources until it does. */
export function setExpression(set: MappingSet, id: string, targetField: string, expression: string): MappingSet {
  const parsed = parseExpression(expression)
  return updateField(set, id, targetField, (field) => ({
    ...field,
    transform: { kind: 'expression', expression },
    sources: parsed.ok ? parsed.fields : field.sources,
    status: 'active',
    manual: true,
  }))
}
