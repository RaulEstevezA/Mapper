// @vitest-environment jsdom
/** The cases in shared/test-cases/, which the desktop version's tests read too (shared/README.md).
 *
 * - calls/<module>.<function>.json: arguments of a core function and the result it must give.
 * - generators/<case>/: two models, the mapping between them and the code every generator writes.
 *
 * `UPDATE_SHARED=1 npm test -- shared` writes the results again from what the web version does now;
 * the desktop version then has to match them. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readInput, reconcile } from '../app/workspace.ts'
import { EXAMPLES } from '../examples/index.ts'
import { generators } from './generate/generators.ts'
import { draftTarget } from './generate/models.ts'
import { buildPlan } from './generate/plan.ts'
import type { GenerateSettings } from './generate/types.ts'
import {
  acceptAllReviews,
  acceptCandidate,
  chooseSources,
  ignoreTarget,
  pruneMappings,
  rejectSuggestion,
  resetField,
  setExpression,
  setFallback,
  setTransform,
  toggleIgnoredSource,
} from './mapping/edit.ts'
import { resolvePath } from './mapping/paths.ts'
import type { MappingSet } from './mapping/types.ts'
import { validateMapping } from './mapping/validate.ts'
import { coverage, defaultTransform, resuggestMapping, sourceOptions, suggestEnumPairs, suggestMapping } from './matching/engine.ts'
import { compatibility } from './model/compatibility.ts'
import { singularize, splitWords, toCamelCase, toPascalCase, toSnakeCase } from './model/naming.ts'
import type { ModelSchema } from './model/schema.ts'
import { detectFormats, parseInput } from './parsers/registry.ts'
import type { InputFormatId } from './parsers/types.ts'
import { readHandoff } from './project/handoff.ts'
import { createProject, readProject } from './project/project.ts'
import { parseExpression } from './transform/expression.ts'

// Tests run from web/ (jsdom gives import.meta.url an http address)
const SHARED = resolve(process.cwd(), '../shared/test-cases')
const UPDATE = process.env.UPDATE_SHARED === '1'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => unknown

const FUNCTIONS: Record<string, AnyFunction> = {
  'naming.splitWords': splitWords,
  'naming.toPascalCase': toPascalCase,
  'naming.toCamelCase': toCamelCase,
  'naming.toSnakeCase': toSnakeCase,
  'naming.singularize': singularize,
  'compatibility.compatibility': compatibility,
  'registry.detectFormats': detectFormats,
  'registry.parseInput': parseInput,
  'engine.suggestMapping': suggestMapping,
  'engine.resuggestMapping': resuggestMapping,
  'engine.sourceOptions': sourceOptions,
  'engine.suggestEnumPairs': suggestEnumPairs,
  'engine.coverage': coverage,
  'engine.defaultTransform': defaultTransform,
  'edit.chooseSources': chooseSources,
  'edit.acceptCandidate': acceptCandidate,
  'edit.rejectSuggestion': rejectSuggestion,
  'edit.ignoreTarget': ignoreTarget,
  'edit.setTransform': setTransform,
  'edit.setFallback': setFallback,
  'edit.resetField': resetField,
  'edit.toggleIgnoredSource': toggleIgnoredSource,
  'edit.acceptAllReviews': acceptAllReviews,
  'edit.pruneMappings': pruneMappings,
  'edit.setExpression': setExpression,
  'validate.validateMapping': validateMapping,
  'paths.resolvePath': resolvePath,
  'expression.parseExpression': parseExpression,
  'plan.buildPlan': buildPlan,
  'models.draftTarget': draftTarget,
  // The date is written as text in the files
  'project.createProject': (source, target, mapping, output, now?: string) =>
    createProject(source, target, mapping, output, now === undefined ? undefined : new Date(now)),
  'project.readProject': readProject,
  'handoff.readHandoff': readHandoff,
  'workspace.readInput': readInput,
  'workspace.reconcile': reconcile,
}

/** What JSON keeps of a value: the files hold JSON, so `undefined` keys disappear as they do there. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value === undefined ? null : value))

const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`)

describe('shared calls', () => {
  const folder = join(SHARED, 'calls')
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.json'))) {
    const name = file.slice(0, -'.json'.length)
    it(name, () => {
      const fn = FUNCTIONS[name]
      expect(fn, `no function for ${file}`).toBeDefined()
      const url = join(folder, file)
      const cases: { args: unknown[]; result: unknown }[] = JSON.parse(readFileSync(url, 'utf8'))
      const results = cases.map((item) => asJson(fn(...item.args)))
      if (UPDATE)
        return writeJson(
          url,
          cases.map((item, index) => ({ args: item.args, result: results[index] })),
        )
      cases.forEach((item, index) => expect(results[index], `${name} #${index}`).toEqual(item.result))
    })
  }
})

interface GeneratorCase {
  source: { text: string; format: InputFormatId; model: string }
  target: { text: string; format: InputFormatId; model: string }
  /** Edits applied after the suggestion, as a user would make them */
  edits?: { fn: string; args: unknown[] }[]
}

/** Every mode, every naming mode with the first mode, and every choice of the options that have choices. */
export function variants(): { key: string; generator: string; settings: GenerateSettings }[] {
  const result: { key: string; generator: string; settings: GenerateSettings }[] = []
  for (const generator of generators) {
    const add = (key: string, settings: Partial<GenerateSettings>) =>
      result.push({
        key: `${generator.id}-${key}`,
        generator: generator.id,
        settings: { mode: generator.modes[0], naming: 'auto', options: {}, ...settings },
      })
    for (const mode of generator.modes) add(mode, { mode })
    for (const naming of ['keep', 'convention'] as const) add(`naming-${naming}`, { naming })
    for (const option of generator.options) {
      if (option.kind === 'text') continue
      for (const choice of option.choices.slice(1)) add(`${option.id}-${choice}`, { options: { [option.id]: choice } })
    }
  }
  return result
}

/** The mapping the case describes: the suggestion with every review accepted, then the case's edits. */
export function prepareCase(input: GeneratorCase): { source: ModelSchema; target: ModelSchema; set: MappingSet } {
  const source = parseInput(input.source.text, input.source.format, { rootName: input.source.model })
  const target = parseInput(input.target.text, input.target.format, { rootName: input.target.model })
  if (!source.ok || !target.ok) throw new Error('The case does not parse')
  let set = suggestMapping(source.schema, input.source.model, target.schema, input.target.model)
  for (const mapping of set.mappings) set = acceptAllReviews(set, mapping.id)
  for (const edit of input.edits ?? []) set = FUNCTIONS[edit.fn](set, ...edit.args) as MappingSet
  return { source: source.schema, target: target.schema, set }
}

describe('shared generator cases', () => {
  const folder = join(SHARED, 'generators')
  if (UPDATE) {
    // The examples of the interface are cases too
    for (const example of EXAMPLES) {
      const url = join(folder, `example-${example.id}`)
      mkdirSync(url, { recursive: true })
      writeJson(join(url, 'input.json'), { source: example.source, target: example.target })
    }
  }
  const cases = existsSync(folder) ? readdirSync(folder).filter((name) => existsSync(join(folder, name, 'input.json'))) : []
  for (const name of cases) {
    it(name, () => {
      const url = join(folder, name)
      const input: GeneratorCase = JSON.parse(readFileSync(join(url, 'input.json'), 'utf8'))
      const prepared = prepareCase(input)
      const plan = buildPlan(prepared.set, prepared.source, prepared.target)
      expect(plan).not.toBeNull()
      const expected: Record<string, unknown> = {}
      for (const variant of variants()) {
        expected[variant.key] = asJson(generators.find((item) => item.id === variant.generator)!.generate(plan!, variant.settings))
      }
      if (UPDATE) {
        writeJson(join(url, 'prepared.json'), prepared)
        writeJson(join(url, 'expected.json'), expected)
        return
      }
      expect(asJson(prepared)).toEqual(JSON.parse(readFileSync(join(url, 'prepared.json'), 'utf8')))
      const stored = JSON.parse(readFileSync(join(url, 'expected.json'), 'utf8'))
      for (const key of Object.keys(expected)) expect(expected[key], key).toEqual(stored[key])
      expect(Object.keys(stored).sort()).toEqual(Object.keys(expected).sort())
    })
  }
})
