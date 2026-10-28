import type { Plan } from './plan.ts'

/** A code generator: turns a plan into source files of one language. Adding a language means adding
 * one of these to generators/index.ts (docs/adding-a-language.md). */

export interface GeneratedFile {
  name: string
  code: string
}

/** Something the user should know about the generated code. Codes are translated by the interface. */
export type GenerationNoteCode =
  'missingValue' | 'unsafeNull' | 'enumFallbackThrows' | 'namesConverted' | 'fallibleConversion' | 'expressionApproximation'

export interface GenerationNote {
  code: GenerationNoteCode
  params?: Record<string, string | number>
}

export interface GeneratedCode {
  files: GeneratedFile[]
  notes: GenerationNote[]
}

export interface GeneratorOption {
  id: string
  /** Value used when the user has chosen none; may depend on the models (see `defaults`) */
  choices: readonly string[]
}

/** How field names of a model are written in the code:
 * - auto: as in the input when it is the same language (or plain objects from JSON), converted otherwise.
 * - keep: always as in the input.
 * - convention: always the language's convention (camelCase, snake_case, PascalCase). */
export type NamingMode = 'auto' | 'keep' | 'convention'

export interface GenerateSettings {
  /** Mode of the generator (`manual`, `mapstruct`, `automapper`) */
  mode: string
  naming: NamingMode
  /** Values of the generator's options, by option id */
  options: Record<string, string>
}

export interface CodeGenerator {
  id: string
  label: string
  /** Highlighting used by the editor */
  editorLanguage: string
  /** Ways of writing the mapping; the first is the default */
  modes: readonly string[]
  options: readonly GeneratorOption[]
  /** Option values that suit the models, used until the user changes them */
  defaults?: (plan: Plan) => Record<string, string>
  generate(plan: Plan, settings: GenerateSettings): GeneratedCode
}

export function optionValue(generator: CodeGenerator, plan: Plan | null, settings: GenerateSettings, id: string): string {
  const option = generator.options.find((item) => item.id === id)
  const chosen = settings.options[id]
  if (option && chosen && option.choices.includes(chosen)) return chosen
  const fallback = plan && generator.defaults ? generator.defaults(plan)[id] : undefined
  return fallback ?? option?.choices[0] ?? ''
}
