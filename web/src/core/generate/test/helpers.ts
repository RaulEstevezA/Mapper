import { suggestMapping } from '../../matching/engine.ts'
import { acceptAllReviews } from '../../mapping/edit.ts'
import type { MappingSet } from '../../mapping/types.ts'
import { parseInput } from '../../parsers/registry.ts'
import type { ModelSchema } from '../../model/schema.ts'
import { EXAMPLES, type Example } from '../../../examples/index.ts'
import { buildPlan, type Plan } from '../plan.ts'

export interface Prepared {
  example: Example
  source: ModelSchema
  target: ModelSchema
  set: MappingSet
  plan: Plan
}

/** An example with its suggested mapping and every review accepted, as a user would leave it. */
export function prepare(example: Example, accept = true): Prepared {
  const source = parseInput(example.source.text, example.source.format, { rootName: example.source.model })
  const target = parseInput(example.target.text, example.target.format, { rootName: example.target.model })
  if (!source.ok || !target.ok) throw new Error(`Example ${example.id} does not parse`)
  let set = suggestMapping(source.schema, example.source.model, target.schema, example.target.model)
  if (accept) for (const mapping of set.mappings) set = acceptAllReviews(set, mapping.id)
  const plan = buildPlan(set, source.schema, target.schema)
  if (!plan) throw new Error(`Example ${example.id} has no plan`)
  return { example, source: source.schema, target: target.schema, set, plan }
}

export const prepared = () => EXAMPLES.map((example) => prepare(example))
