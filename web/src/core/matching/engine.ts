import { compatibility, type Compatibility } from '../model/compatibility.ts'
import { nameWords } from '../model/naming.ts'
import {
  allFields,
  findEnum,
  findModel,
  needsValue,
  type FieldDef,
  type ModelDef,
  type ModelSchema,
  type TypeRef,
} from '../model/schema.ts'
import {
  mappingId,
  pathKey,
  type Candidate,
  type Confidence,
  type EnumPair,
  type FieldMapping,
  type MappingSet,
  type ModelMapping,
  type Reason,
  type SourcePath,
  type Transform,
} from '../mapping/types.ts'
import { compareNames, expandedWords, meaningWords, modelWords, type NameContext } from './names.ts'

/** The automatic matching engine: proposes, for every target field, the source that most likely gives
 * its value, with a confidence. It never resolves an ambiguity: close alternatives become a conflict
 * that the user decides (docs/mapping-engine.md). */

// Thresholds of the confidence scale
// Only identical names (or the same name on the wire) are exact: a convention change is "high"
const EXACT = 0.99
const HIGH = 0.85
const PROBABLE = 0.7
const REVIEW = 0.5
// Two candidates closer than this are ambiguous
const MARGIN = 0.06
// Nested fields are offered as sources down to this depth (`customer.address.city`)
const MAX_DEPTH = 3
// A path through a nested object is slightly less likely than a field of the model itself
const FLATTEN_FACTOR = 0.96

export interface SourceOption {
  path: SourcePath
  field: FieldDef
  /** Words of the whole path */
  words: string[]
  /** Some step before the last one can be null */
  nullablePath: boolean
}

export function confidenceOf(score: number): Confidence {
  if (score >= EXACT) return 'exact'
  if (score >= HIGH) return 'high'
  if (score >= PROBABLE) return 'probable'
  if (score >= REVIEW) return 'review'
  return 'none'
}

/** Fields of the source model and of its nested objects, as paths. Lists are not entered: their
 * elements are mapped by a collection. */
export function sourceOptions(
  schema: ModelSchema,
  model: ModelDef,
  depth = 1,
  prefix: SourcePath = [],
  nullablePrefix = false,
  seen = new Set<string>(),
): SourceOption[] {
  const options: SourceOption[] = []
  if (seen.has(model.name)) return options
  const nextSeen = new Set(seen).add(model.name)
  for (const field of allFields(schema, model)) {
    const path = [...prefix, field.name]
    options.push({ path, field, words: path.flatMap((part) => nameWords(part)), nullablePath: nullablePrefix })
    if (field.type.kind === 'model' && depth < MAX_DEPTH) {
      const nested = findModel(schema, field.type.name)
      if (nested)
        options.push(...sourceOptions(schema, nested, depth + 1, path, nullablePrefix || field.nullable || field.optional, nextSeen))
    }
  }
  return options
}

interface Context {
  source: ModelSchema
  target: ModelSchema
  mappings: Map<string, ModelMapping>
}

/** How likely a value of `source` type can fill a field of `target` type, from 0 to 1. */
function typeFactor(result: Compatibility, sourceType: TypeRef, targetType: TypeRef, context: Context): number {
  switch (result.level) {
    case 'same':
      return 1
    case 'widening':
      return 0.98
    case 'conversion':
      return result.fallible ? 0.88 : result.lossy ? 0.85 : 0.9
    case 'transform':
      return 0.6
    case 'nested':
      return 0.6 + 0.4 * structuralSimilarity(sourceType, targetType, context)
    case 'collection': {
      const inner = (type: TypeRef): TypeRef => (type.kind === 'array' ? type.items : type.kind === 'map' ? type.value : type)
      return result.items ? typeFactor(result.items, inner(sourceType), inner(targetType), context) : 0.9
    }
    case 'incompatible':
      return 0
  }
}

/** Share of the target model's fields that some source field matches by name. */
function structuralSimilarity(sourceType: TypeRef, targetType: TypeRef, context: Context): number {
  if (sourceType.kind !== 'model' || targetType.kind !== 'model') return 0
  const sourceModel = findModel(context.source, sourceType.name)
  const targetModel = findModel(context.target, targetType.name)
  if (!sourceModel || !targetModel) return 0
  const targetFields = allFields(context.target, targetModel)
  if (targetFields.length === 0) return 0
  const sourceFields = allFields(context.source, sourceModel)
  const names: NameContext = { sourceModel: modelWords(sourceModel.name), targetModel: modelWords(targetModel.name) }
  const matched = targetFields.filter((targetField) =>
    sourceFields.some(
      (sourceField) => (compareNames(sourceField.name, nameWords(sourceField.name), targetField.name, names)?.score ?? 0) >= PROBABLE,
    ),
  ).length
  return matched / targetFields.length
}

function compatibilityReasons(result: Compatibility, sourceNullable: boolean, target: FieldDef): Reason[] {
  const reasons: Reason[] = []
  const level = result.level === 'collection' ? (result.items?.level ?? 'same') : result.level
  if (level === 'conversion')
    reasons.push({ code: result.fallible || result.items?.fallible ? 'typeFallible' : result.lossy ? 'typeLossy' : 'typeConversion' })
  if (level === 'transform') reasons.push({ code: 'typeTransform' })
  if (level === 'nested') reasons.push({ code: 'nestedModel' })
  if (result.level === 'collection') reasons.push({ code: 'collection' })
  if (sourceNullable && !target.nullable && target.defaultValue === undefined) reasons.push({ code: 'nullToRequired' })
  return reasons
}

/** Score of using one source option for a target field, or null when it makes no sense. */
function scoreOption(option: SourceOption, target: FieldDef, names: NameContext, context: Context): Candidate | null {
  const pathMatch = compareNames(option.path.length === 1 ? option.field.name : pathKey(option.path), option.words, target.name, names)
  // A nested field may match by its own name (`shipping.city` → `city`), less surely than by the whole path
  const leaf = option.path.length > 1 ? compareNames(option.field.name, nameWords(option.field.name), target.name, names) : null
  const leafMatch = leaf ? { ...leaf, score: leaf.score * 0.82 } : null
  const best = pathMatch && leafMatch ? (pathMatch.score >= leafMatch.score ? pathMatch : leafMatch) : (pathMatch ?? leafMatch)
  const nameMatch =
    best ??
    // The name on the wire or an alias may be the one that matches (`@JsonProperty("user_id")`)
    [option.field.serializedName, ...(option.field.aliases ?? [])]
      .filter((name): name is string => name !== undefined)
      .map((name) => compareNames(name, nameWords(name), target.serializedName ?? target.name, names))
      .find((match) => match !== null && match.score >= HIGH) ??
    null
  let serialized = false
  let match = nameMatch
  // The name of the field's type completes the name: `shipping: AddressApi` and `shippingAddress: Address`
  if (!match || match.score < HIGH) {
    const typeWords = (type: TypeRef) => (type.kind === 'model' || type.kind === 'enum' ? modelWords(type.name) : [])
    const strip = (words: string[], type: TypeRef) => {
      const extra = typeWords(type)
      return extra.length > 0 &&
        words.length > extra.length &&
        extra.every((word, index) => words[words.length - extra.length + index] === word)
        ? words.slice(0, -extra.length)
        : words
    }
    const sourceWords = strip(option.words, option.field.type)
    const targetWords = strip(nameWords(target.name), target.type)
    if (
      (sourceWords !== option.words || targetWords.length !== nameWords(target.name).length) &&
      sourceWords.join(' ') === targetWords.join(' ')
    ) {
      match = { score: 0.86, reason: 'modelContext' }
    }
  }
  if (option.field.serializedName && target.serializedName && option.field.serializedName === target.serializedName) {
    if (!match || match.score < 0.95) {
      match = { score: 0.95, reason: 'serializedName' }
      serialized = true
    }
  }
  if (!match) return null
  const result = compatibility(option.field.type, target.type)
  let factor = typeFactor(result, option.field.type, target.type, context)
  // Two enums are as compatible as the share of values that pair up by name
  if (option.field.type.kind === 'enum' && target.type.kind === 'enum' && option.field.type.name !== target.type.name) {
    const total = findEnum(context.source, option.field.type.name)?.values.length ?? 0
    const paired = suggestEnumPairs(context.source, option.field.type.name, context.target, target.type.name).length
    factor = total > 0 ? 0.6 + 0.4 * (paired / total) : 0.6
  }
  if (factor === 0) return null
  const nullable = option.field.nullable || option.field.optional || option.nullablePath
  const nullFactor = nullable && !target.nullable && !target.optional && target.defaultValue === undefined ? 0.97 : 1
  const depthFactor = option.path.length > 1 ? FLATTEN_FACTOR ** (option.path.length - 1) : 1
  const score = match.score * factor * nullFactor * depthFactor
  if (score < REVIEW) return null
  const reasons: Reason[] = [
    {
      code: serialized ? 'serializedName' : match.reason,
      ...(match.similarity !== undefined ? { params: { similarity: match.similarity } } : {}),
    },
  ]
  if (option.path.length > 1) reasons.push({ code: 'flattened', params: { path: pathKey(option.path) } })
  reasons.push(...compatibilityReasons(result, nullable, target))
  return {
    sources: [option.path],
    transform: transformFor(result, option.field.type, target.type),
    score,
    confidence: confidenceOf(score),
    reasons,
  }
}

/** The transformation a single source needs, from the compatibility of the two types. Nested models
 * and collections get their mapping id later. */
function transformFor(result: Compatibility, source: TypeRef, target: TypeRef): Transform {
  if (result.level === 'nested') return { kind: 'object', mapping: '' }
  if (result.level === 'collection') return { kind: 'collection' }
  if (result.level === 'transform') {
    if (source.kind === 'enum' && target.kind === 'enum') return { kind: 'enum', pairs: [] }
    const isNumber = (type: TypeRef) => type.kind === 'primitive' && (type.name === 'integer' || type.name === 'float')
    const isDate = (type: TypeRef) => type.kind === 'primitive' && (type.name === 'datetime' || type.name === 'date')
    if ((isNumber(source) && isDate(target)) || (isDate(source) && isNumber(target))) return { kind: 'epoch', unit: 'seconds' }
    if (target.kind === 'primitive' && target.name === 'boolean') return { kind: 'boolean', trueValues: [] }
  }
  return { kind: 'direct' }
}

/** Suggestions that combine or split values: first + last → full name, full name → first / last,
 * cents → amount, status → active, epoch → date. */
function combinedCandidates(options: SourceOption[], target: FieldDef, context: Context): Candidate[] {
  const results: Candidate[] = []
  const targetWords = meaningWords(expandedWords(target.name))
  const isText = (type: TypeRef) => type.kind === 'primitive' && type.name === 'string'
  const topLevel = options.filter((option) => option.path.length === 1)
  const find = (predicate: (words: string[]) => boolean) =>
    topLevel.find((option) => isText(option.field.type) && predicate(meaningWords(expandedWords(option.field.name))))
  const has = (words: string[], ...wanted: string[]) => wanted.every((word) => words.includes(word))

  if (
    isText(target.type) &&
    (has(targetWords, 'full', 'name') || has(targetWords, 'display', 'name') || (targetWords.length === 1 && targetWords[0] === 'name'))
  ) {
    const first = find((words) => has(words, 'given', 'name') || (words.length === 1 && words[0] === 'given'))
    const last = find((words) => has(words, 'family', 'name') || (words.length === 1 && words[0] === 'family'))
    if (first && last) {
      const score = targetWords.includes('full') ? 0.86 : 0.72
      results.push({
        sources: [first.path, last.path],
        transform: { kind: 'concat', separator: ' ' },
        score,
        confidence: confidenceOf(score),
        reasons: [{ code: 'combined' }],
      })
    }
  }

  // Synonyms are compared by their canonical word: "first" is read as "given" and "last" as "family"
  if (isText(target.type) && (has(targetWords, 'given', 'name') || has(targetWords, 'family', 'name'))) {
    const full = find((words) => has(words, 'full', 'name') || (words.length === 1 && words[0] === 'name'))
    if (full) {
      const part = has(targetWords, 'given') ? 0 : 'rest'
      results.push({
        sources: [full.path],
        transform: { kind: 'split', separator: ' ', part },
        score: 0.6,
        confidence: 'review',
        reasons: [{ code: 'split' }],
      })
    }
  }

  const isNumber = (type: TypeRef) =>
    type.kind === 'primitive' && (type.name === 'integer' || type.name === 'float' || type.name === 'decimal')
  if (isNumber(target.type)) {
    for (const option of topLevel) {
      const words = meaningWords(expandedWords(option.field.name))
      // `cents` is singularized to `cent`
      if (!isNumber(option.field.type) || !words.includes('cent')) continue
      const rest = words.filter((word) => word !== 'cent')
      if (rest.length > 0 && rest.join(' ') === targetWords.join(' ')) {
        results.push({
          sources: [option.path],
          transform: { kind: 'arithmetic', operator: '/', operand: 100 },
          score: 0.8,
          confidence: 'probable',
          reasons: [{ code: 'cents' }],
        })
      }
    }
  }

  if (
    target.type.kind === 'primitive' &&
    target.type.name === 'boolean' &&
    (targetWords.includes('active') || targetWords.includes('enabled'))
  ) {
    const status = topLevel.find((option) => ['status', 'state'].includes(meaningWords(expandedWords(option.field.name)).join(' ')))
    if (status && (isText(status.field.type) || status.field.type.kind === 'enum')) {
      const values =
        status.field.type.kind === 'enum' ? (findEnum(context.source, status.field.type.name)?.values.map((value) => value.name) ?? []) : []
      const trueValues = values.filter((value) => /^(active|enabled|on|yes)$/i.test(value))
      results.push({
        sources: [status.path],
        transform: { kind: 'boolean', trueValues: trueValues.length > 0 ? trueValues : ['ACTIVE'] },
        score: 0.62,
        confidence: 'review',
        reasons: [{ code: 'typeTransform' }],
      })
    }
  }
  return results
}

/** Value pairs between two enums, matched by name or wire value, ignoring case and separators. */
export function suggestEnumPairs(source: ModelSchema, sourceEnum: string, target: ModelSchema, targetEnum: string): EnumPair[] {
  const from = findEnum(source, sourceEnum)?.values ?? []
  const to = findEnum(target, targetEnum)?.values ?? []
  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
  const pairs: EnumPair[] = []
  for (const value of from) {
    const keys = [key(value.name), value.value !== undefined ? key(String(value.value)) : '']
    const match = to.find(
      (candidate) => keys.includes(key(candidate.name)) || (candidate.value !== undefined && keys.includes(key(String(candidate.value)))),
    )
    if (match) pairs.push({ from: value.name, to: match.name })
  }
  return pairs
}

/** Ranks candidates per target, then assigns sources greedily (each source used once by the automatic
 * suggestions), turning close alternatives into conflicts. */
function assign(
  candidatesByTarget: Map<string, Candidate[]>,
  targets: FieldDef[],
): Map<string, { chosen: Candidate | null; conflict: boolean }> {
  const result = new Map<string, { chosen: Candidate | null; conflict: boolean }>()
  const usedSources = new Set<string>()
  const pairs = targets.flatMap((target) =>
    (candidatesByTarget.get(target.name) ?? []).map((candidate) => ({ target: target.name, candidate })),
  )
  pairs.sort((a, b) => b.candidate.score - a.candidate.score)
  const key = (candidate: Candidate) => candidate.sources.map(pathKey).join('+')
  const decided = new Set<string>()
  // Pairs by source, to find the other targets that want a source without going through every pair
  const pairsBySource = new Map<string, typeof pairs>()
  for (const pair of pairs) {
    for (const path of pair.candidate.sources) {
      const sourceKey = pathKey(path)
      pairsBySource.set(sourceKey, [...(pairsBySource.get(sourceKey) ?? []), pair])
    }
  }

  for (const { target, candidate } of pairs) {
    if (decided.has(target)) continue
    const sourceKeys = candidate.sources.map(pathKey)
    // Derived values (a part of a text, a flag computed from a status) do not use their source up:
    // other targets can still take it (first name and last name; status and active)
    const shares = candidate.transform.kind === 'split' || candidate.transform.kind === 'boolean'
    if (!shares && sourceKeys.some((sourceKey) => usedSources.has(sourceKey))) continue
    if (candidate.confidence !== 'exact' && !shares) {
      // Another source almost as good for this target
      const rivalsForTarget = (candidatesByTarget.get(target) ?? []).filter(
        (other) =>
          other !== candidate &&
          key(other) !== key(candidate) &&
          other.score >= REVIEW &&
          candidate.score - other.score < MARGIN &&
          !other.sources.some((path) => usedSources.has(pathKey(path))),
      )
      // Another undecided target that wants this source almost as much
      const rivalTargets = [...new Set(sourceKeys.flatMap((sourceKey) => pairsBySource.get(sourceKey) ?? []))].filter(
        (other) =>
          other.target !== target &&
          other.candidate.transform.kind !== 'split' &&
          other.candidate.transform.kind !== 'boolean' &&
          !decided.has(other.target) &&
          other.candidate.sources.some((path) => sourceKeys.includes(pathKey(path))) &&
          candidate.score - other.candidate.score < MARGIN &&
          other.candidate.score >= REVIEW,
      )
      if (rivalsForTarget.length > 0 || rivalTargets.length > 0) {
        result.set(target, { chosen: candidate, conflict: true })
        decided.add(target)
        for (const rival of rivalTargets) {
          if (!decided.has(rival.target)) {
            result.set(rival.target, { chosen: rival.candidate, conflict: true })
            decided.add(rival.target)
          }
        }
        continue
      }
    }
    result.set(target, { chosen: candidate, conflict: false })
    decided.add(target)
    if (!shares) for (const sourceKey of sourceKeys) usedSources.add(sourceKey)
  }
  for (const target of targets) if (!result.has(target.name)) result.set(target.name, { chosen: null, conflict: false })
  return result
}

function statusFor(confidence: Confidence): FieldMapping['status'] {
  return confidence === 'exact' || confidence === 'high' || confidence === 'probable'
    ? 'active'
    : confidence === 'none'
      ? 'unmapped'
      : 'pending'
}

/** A target model field filled from the source model itself (flat source → nested target), when enough
 * of its fields have a match among the source's top-level fields. */
function rootCandidate(sourceModel: ModelDef, target: FieldDef, context: Context): Candidate | null {
  if (target.type.kind !== 'model') return null
  const nestedTarget = findModel(context.target, target.type.name)
  if (!nestedTarget) return null
  const similarity = structuralSimilarity({ kind: 'model', name: sourceModel.name }, target.type, context)
  if (similarity < 0.5) return null
  const score = Math.min(0.78, 0.4 + similarity * 0.4)
  return {
    sources: [[]],
    transform: { kind: 'object', mapping: '' },
    score,
    confidence: confidenceOf(score),
    reasons: [{ code: 'builtFromRoot' }],
  }
}

/** Fills in the mapping ids of nested objects and collections, suggesting those mappings too, and the
 * value pairs of enum transformations. */
function completeTransform(candidate: Candidate, sourceModel: ModelDef, target: FieldDef, context: Context): Candidate {
  const transform = candidate.transform
  const sourceType = (): TypeRef | null => {
    const path = candidate.sources[0]
    if (!path) return null
    if (path.length === 0) return { kind: 'model', name: sourceModel.name }
    let model: ModelDef | undefined = sourceModel
    let type: TypeRef | null = null
    for (const part of path) {
      const field: FieldDef | undefined = model ? allFields(context.source, model).find((item) => item.name === part) : undefined
      if (!field) return null
      type = field.type
      model = field.type.kind === 'model' ? findModel(context.source, field.type.name) : undefined
    }
    return type
  }
  const inner = (type: TypeRef | null): TypeRef | null =>
    type?.kind === 'array' ? inner(type.items) : type?.kind === 'map' ? inner(type.value) : type
  if (transform.kind === 'object') {
    const from = sourceType()
    if (from?.kind === 'model' && target.type.kind === 'model') {
      return { ...candidate, transform: { kind: 'object', mapping: ensureMapping(from.name, target.type.name, context) } }
    }
  }
  if (transform.kind === 'collection') {
    const from = inner(sourceType())
    const to = inner(target.type)
    if (from?.kind === 'model' && to?.kind === 'model')
      return { ...candidate, transform: { kind: 'collection', mapping: ensureMapping(from.name, to.name, context) } }
  }
  if (transform.kind === 'enum') {
    const from = sourceType()
    if (from?.kind === 'enum' && target.type.kind === 'enum')
      return {
        ...candidate,
        transform: { kind: 'enum', pairs: suggestEnumPairs(context.source, from.name, context.target, target.type.name) },
      }
  }
  return candidate
}

function suggestFields(sourceModel: ModelDef, targetModel: ModelDef, context: Context): FieldMapping[] {
  const options = sourceOptions(context.source, sourceModel)
  const targets = allFields(context.target, targetModel)
  const names: NameContext = { sourceModel: modelWords(sourceModel.name), targetModel: modelWords(targetModel.name) }
  const candidatesByTarget = new Map<string, Candidate[]>()
  for (const target of targets) {
    const candidates = options
      .map((option) => scoreOption(option, target, names, context))
      .filter((candidate): candidate is Candidate => candidate !== null)
    candidates.push(...combinedCandidates(options, target, context))
    const root = rootCandidate(sourceModel, target, context)
    if (root && !candidates.some((candidate) => candidate.score >= root.score)) candidates.push(root)
    // The same source may appear through two rules: keep its best
    const best = new Map<string, Candidate>()
    for (const candidate of candidates) {
      const key = `${candidate.sources.map(pathKey).join('+')}:${candidate.transform.kind}`
      if ((best.get(key)?.score ?? -1) < candidate.score) best.set(key, candidate)
    }
    candidatesByTarget.set(
      target.name,
      [...best.values()].sort((a, b) => b.score - a.score),
    )
  }

  const assignment = assign(candidatesByTarget, targets)
  return targets.map((target): FieldMapping => {
    const { chosen, conflict } = assignment.get(target.name)!
    const candidates = (candidatesByTarget.get(target.name) ?? []).slice(0, 5)
    if (!chosen) {
      // Generated fields (ids, timestamps) need nothing; the rest is left for the user
      return {
        target: target.name,
        sources: [],
        transform: { kind: 'direct' },
        status: 'unmapped',
        confidence: 'none',
        ...(candidates.length > 0 ? { candidates } : {}),
      }
    }
    const completed = completeTransform(chosen, sourceModel, target, context)
    const confidence: Confidence = conflict ? 'conflict' : completed.confidence
    const ordered = [completed, ...candidates.filter((candidate) => candidate !== chosen)].map((candidate) =>
      candidate === completed ? candidate : completeTransform(candidate, sourceModel, target, context),
    )
    // A transformation without enough information (which texts are true) always needs a review
    const incomplete = completed.transform.kind === 'boolean' && completed.transform.trueValues.length === 0
    const status = conflict ? 'pending' : incomplete ? 'pending' : statusFor(confidence)
    return {
      target: target.name,
      sources: completed.sources,
      transform: completed.transform,
      status,
      confidence: incomplete && confidence !== 'conflict' ? 'review' : confidence,
      reasons: completed.reasons,
      candidates: ordered,
    }
  })
}

/** Creates (once) the mapping between two models and returns its id. */
export function ensureMapping(source: string, target: string, context: Context): string {
  const id = mappingId(source, target)
  if (context.mappings.has(id)) return id
  const sourceModel = findModel(context.source, source)
  const targetModel = findModel(context.target, target)
  const mapping: ModelMapping = { id, source, target, fields: [], ignoredSources: [] }
  // Registered before its fields, so recursive models (a Category with child categories) end
  context.mappings.set(id, mapping)
  if (sourceModel && targetModel) mapping.fields = suggestFields(sourceModel, targetModel, context)
  return id
}

/** Suggests the whole mapping from one source model to one target model, nested models included. */
export function suggestMapping(source: ModelSchema, sourceModel: string, target: ModelSchema, targetModel: string): MappingSet {
  const context: Context = { source, target, mappings: new Map() }
  const root = ensureMapping(sourceModel, targetModel, context)
  return { root, mappings: [...context.mappings.values()] }
}

/** Recomputes the suggestions of one model mapping (after "restore suggestions"), keeping the others. */
export function resuggestMapping(set: MappingSet, id: string, source: ModelSchema, target: ModelSchema): MappingSet {
  const current = set.mappings.find((mapping) => mapping.id === id)
  if (!current) return set
  const context: Context = {
    source,
    target,
    mappings: new Map(set.mappings.filter((mapping) => mapping.id !== id).map((mapping) => [mapping.id, mapping])),
  }
  const fresh: ModelMapping = { ...current, fields: [] }
  context.mappings.set(id, fresh)
  const sourceModel = findModel(source, current.source)
  const targetModel = findModel(target, current.target)
  if (sourceModel && targetModel) fresh.fields = suggestFields(sourceModel, targetModel, context)
  const mappings = set.mappings.map((mapping) => (mapping.id === id ? fresh : mapping))
  for (const [mappingIdValue, mapping] of context.mappings) if (!mappings.some((item) => item.id === mappingIdValue)) mappings.push(mapping)
  return { root: set.root, mappings }
}

/** Fields the target needs that receive nothing, and source fields nobody uses. */
export function coverage(mapping: ModelMapping, source: ModelSchema, target: ModelSchema) {
  const sourceModel = findModel(source, mapping.source)
  const targetModel = findModel(target, mapping.target)
  const used = new Set<string>()
  for (const field of mapping.fields) {
    if (field.status !== 'active' && field.status !== 'pending') continue
    for (const path of field.sources) {
      // Using `address.city` also uses `address`; using the whole object uses every field below it
      for (let length = 1; length <= path.length; length++) used.add(pathKey(path.slice(0, length)))
    }
    if (field.sources.some((path) => path.length === 0))
      for (const option of sourceModel ? sourceOptions(source, sourceModel, 1) : [])
        if (option.path.length === 1) used.add(pathKey(option.path))
  }
  const unusedSources = sourceModel
    ? allFields(source, sourceModel)
        .filter((field) => !used.has(field.name))
        .map((field) => field.name)
    : []
  const missingRequired = targetModel
    ? allFields(target, targetModel)
        .filter((field) => needsValue(field))
        .filter((field) => {
          const fieldMapping = mapping.fields.find((item) => item.target === field.name)
          return !fieldMapping || fieldMapping.status !== 'active'
        })
        .map((field) => field.name)
    : []
  return { unusedSources, missingRequired }
}

/** The transformation used when the user picks sources for a target field by hand: the one the types
 * call for, with the nested mapping suggested when the value is an object or a list of objects. */
export function defaultTransform(
  set: MappingSet,
  source: ModelSchema,
  target: ModelSchema,
  id: string,
  targetField: string,
  sources: SourcePath[],
): { set: MappingSet; transform: Transform } {
  const current = set.mappings.find((mapping) => mapping.id === id)
  const sourceModel = current && findModel(source, current.source)
  const targetModel = current && findModel(target, current.target)
  const field = targetModel && allFields(target, targetModel).find((item) => item.name === targetField)
  if (!current || !sourceModel || !field) return { set, transform: { kind: 'direct' } }
  if (sources.length === 0) return { set, transform: { kind: 'constant', value: null } }
  if (sources.length > 1) return { set, transform: { kind: 'concat', separator: ' ' } }
  const context: Context = { source, target, mappings: new Map(set.mappings.map((mapping) => [mapping.id, mapping])) }
  let type: TypeRef | null = { kind: 'model', name: sourceModel.name }
  let model: ModelDef | undefined = sourceModel
  for (const part of sources[0]) {
    const step: FieldDef | undefined = model ? allFields(source, model).find((item) => item.name === part) : undefined
    if (!step) {
      type = null
      break
    }
    type = step.type
    model = step.type.kind === 'model' ? findModel(source, step.type.name) : undefined
  }
  if (!type) return { set, transform: { kind: 'direct' } }
  const result = compatibility(type, field.type)
  const candidate = completeTransform(
    { sources, transform: transformFor(result, type, field.type), score: 1, confidence: 'exact', reasons: [] },
    sourceModel,
    field,
    context,
  )
  const mappings = [...context.mappings.values()]
  return { set: { root: set.root, mappings }, transform: candidate.transform }
}
