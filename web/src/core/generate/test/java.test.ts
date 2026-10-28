import { describe, expect, it } from 'vitest'
import { javaGenerator } from '../languages/java.ts'
import type { GenerateSettings } from '../types.ts'
import { hasCommand, runChecker } from './compile.ts'
import { prepared } from './helpers.ts'
import { javaDeclarations } from './javaDeclarations.ts'

const javac = hasCommand('javac', ['-version'])
const manual: GenerateSettings = { mode: 'manual', naming: 'auto', options: {} }
const mapstruct: GenerateSettings = { mode: 'mapstruct', naming: 'auto', options: { componentModel: 'spring' } }

describe('Java generator', () => {
  for (const { example, plan, source, target } of prepared()) {
    it(`generates code that compiles: ${example.id}`, async () => {
      const file = javaGenerator.generate(plan, manual).files[0]
      await expect(file.code).toMatchFileSnapshot(`__snapshots__/java/${example.id}.java`)
      if (!javac) return
      const sameNames = source.models.some((model) => target.models.some((other) => other.name === model.name))
      if (sameNames) return
      const errors = runChecker(
        { [file.name]: file.code, 'SourceModels.java': javaDeclarations(source), 'TargetModels.java': javaDeclarations(target) },
        'javac',
        () => ['-d', 'out', '-Xlint:none', file.name, 'SourceModels.java', 'TargetModels.java'],
      )
      expect(errors).toBe('')
    }, 60000)

    it(`writes a MapStruct mapper: ${example.id}`, async () => {
      const code = javaGenerator.generate(plan, mapstruct).files[0].code
      await expect(code).toMatchFileSnapshot(`__snapshots__/java-mapstruct/${example.id}.java`)
      expect(code).toContain('@Mapper(componentModel = "spring"')
    })
  }
})
