import { cSharpGenerator } from './languages/csharp.ts'
import { dartGenerator } from './languages/dart.ts'
import { goGenerator } from './languages/go.ts'
import { javaGenerator } from './languages/java.ts'
import { kotlinGenerator } from './languages/kotlin.ts'
import { phpGenerator } from './languages/php.ts'
import { pythonGenerator } from './languages/python.ts'
import { rustGenerator } from './languages/rust.ts'
import { swiftGenerator } from './languages/swift.ts'
import { javaScriptGenerator, typeScriptGenerator } from './languages/typescript.ts'
import type { CodeGenerator } from './types.ts'

/** Every output language, in the order the selector shows them. Adding a language means adding it here. */
export const generators: readonly CodeGenerator[] = [
  typeScriptGenerator,
  javaScriptGenerator,
  pythonGenerator,
  javaGenerator,
  cSharpGenerator,
  kotlinGenerator,
  dartGenerator,
  swiftGenerator,
  goGenerator,
  rustGenerator,
  phpGenerator,
]

export function findGenerator(id: string): CodeGenerator {
  return generators.find((generator) => generator.id === id) ?? typeScriptGenerator
}
