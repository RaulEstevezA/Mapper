import type { Literal } from '../model/schema.ts'

/** The internal mapping: how every field of a target model gets its value from a source model.
 * Language-neutral, like the models; generators turn it into code (docs/internal-model.md). */

/** Path of a value from the source model: `[]` is the whole source object, `['address', 'city']` a
 * nested field. */
export type SourcePath = string[]

/** How sure the engine is about a suggestion (patterns/confidence-states.md in personal_web_style). */
export type Confidence = 'exact' | 'high' | 'probable' | 'review' | 'conflict' | 'none'

/** - active: part of the mapping; the generated code uses it.
 * - pending: a suggestion the user has to confirm (review or conflict); not in the code yet.
 * - ignored: the user decided this target field gets no value.
 * - unmapped: nothing was found or chosen. */
export type FieldStatus = 'active' | 'pending' | 'ignored' | 'unmapped'

export type ArithmeticOperator = '*' | '/' | '+' | '-'

/** How the source values become the target value. Conversions between compatible types ("123" → 123,
 * date → text) are implied by `direct`: the generators write them from the two types. */
export type Transform =
  /** The value of the single source, renamed and converted when the types differ */
  | { kind: 'direct' }
  /** The sources' text joined with a separator (`first + " " + last`) */
  | { kind: 'concat'; separator: string }
  /** One part of the source text split by a separator: an index from 0, the last part, or everything
   * after the first part (`rest`, for "first name / last name") */
  | { kind: 'split'; separator: string; part: number | 'last' | 'rest' }
  /** Always the same value; it uses no source */
  | { kind: 'constant'; value: Literal }
  /** Texts (or enum values) that mean true; anything else is false */
  | { kind: 'boolean'; trueValues: string[] }
  /** Source enum value or text → target enum value. Values without a pair use `fallback` (a target
   * value) or fail in the generated code */
  | { kind: 'enum'; pairs: EnumPair[]; fallback?: string }
  /** A number of seconds or milliseconds since 1970 ↔ a date and time (direction from the types) */
  | { kind: 'epoch'; unit: 'seconds' | 'milliseconds' }
  /** `price_cents / 100` */
  | { kind: 'arithmetic'; operator: ArithmeticOperator; operand: number }
  /** A nested object mapped with another model mapping (by id). The source is a nested object, or the
   * root (`[]`) when a flat source fills a nested target */
  | { kind: 'object'; mapping: string }
  /** A list mapped element by element: with a model mapping for objects, or converted for scalars */
  | { kind: 'collection'; mapping?: string }
  /** A custom expression in Mapper's small, safe expression language (transform/expression.ts) */
  | { kind: 'expression'; expression: string }

export interface EnumPair {
  from: string
  to: string
}

/** Why the engine suggested a source: shown to the user as the explanation of the confidence. */
export type ReasonCode =
  | 'sameName'
  | 'sameWords'
  | 'serializedName'
  | 'modelContext'
  | 'synonym'
  | 'abbreviation'
  | 'similarName'
  | 'containsName'
  | 'flattened'
  | 'typeConversion'
  | 'typeFallible'
  | 'typeLossy'
  | 'typeTransform'
  | 'nullToRequired'
  | 'nestedModel'
  | 'collection'
  | 'combined'
  | 'split'
  | 'cents'
  | 'builtFromRoot'

export interface Reason {
  code: ReasonCode
  params?: Record<string, string | number>
}

/** An alternative the engine found for a target field. */
export interface Candidate {
  sources: SourcePath[]
  transform: Transform
  /** 0 to 1 */
  score: number
  confidence: Confidence
  reasons: Reason[]
}

export interface FieldMapping {
  /** Name of the target field */
  target: string
  sources: SourcePath[]
  transform: Transform
  /** Value used when the source is null or missing (`null → default`) */
  fallback?: Literal
  status: FieldStatus
  /** Set by the engine; kept when the user only confirms the suggestion */
  confidence: Confidence
  /** The user chose or changed this mapping */
  manual?: boolean
  reasons?: Reason[]
  /** Suggestions, the best first: the one applied (or proposed) and the alternatives */
  candidates?: Candidate[]
}

export interface ModelMapping {
  /** `Source->Target`: unique per pair of models */
  id: string
  source: string
  target: string
  /** One entry per target field, in the target's order */
  fields: FieldMapping[]
  /** Source paths the user marked as intentionally unused (`legacy_code → ignored`) */
  ignoredSources: string[]
}

/** Every model mapping reachable from the root one. */
export interface MappingSet {
  root: string
  mappings: ModelMapping[]
}

export function mappingId(source: string, target: string): string {
  return `${source}->${target}`
}

export function findMapping(set: MappingSet, id: string): ModelMapping | undefined {
  return set.mappings.find((mapping) => mapping.id === id)
}

export function pathKey(path: SourcePath): string {
  return path.join('.')
}

/** Sources a transformation needs: none for a constant, two or more for a concatenation, one otherwise
 * (an expression names its own). */
export function sourceCount(transform: Transform): { min: number; max: number } {
  switch (transform.kind) {
    case 'constant':
      return { min: 0, max: 0 }
    case 'concat':
      return { min: 2, max: 16 }
    case 'expression':
      return { min: 0, max: 16 }
    default:
      return { min: 1, max: 1 }
  }
}
