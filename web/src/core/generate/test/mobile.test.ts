import { describe, expect, it } from 'vitest'
import { dartGenerator } from '../languages/dart.ts'
import { kotlinGenerator } from '../languages/kotlin.ts'
import { swiftGenerator } from '../languages/swift.ts'
import type { GenerateSettings } from '../types.ts'
import { hasCommand, runChecker } from './compile.ts'
import { prepared } from './helpers.ts'

const settings: GenerateSettings = { mode: 'extensions', naming: 'auto', options: {} }
const dart = hasCommand('dart')
const swift = hasCommand('swiftc', ['-version'])

describe('Kotlin generator', () => {
  for (const { example, plan } of prepared()) {
    it(`writes extension functions: ${example.id}`, async () => {
      const code = kotlinGenerator.generate(plan, settings).files[0].code
      await expect(code).toMatchFileSnapshot(`__snapshots__/kotlin/${example.id}.kt`)
    })
  }
})

describe('Dart generator', () => {
  for (const { example, plan } of prepared()) {
    it(`writes valid Dart: ${example.id}`, async () => {
      const file = dartGenerator.generate(plan, settings).files[0]
      await expect(file.code).toMatchFileSnapshot(`__snapshots__/dart/${example.id}.dart`)
      if (dart) expect(runChecker({ 'mapping.dart': file.code }, 'dart', () => ['format', '--output=none', 'mapping.dart'])).toBe('')
    }, 60000)
  }
})

describe('Swift generator', () => {
  for (const { example, plan } of prepared()) {
    it(`writes valid Swift: ${example.id}`, async () => {
      const file = swiftGenerator.generate(plan, settings).files[0]
      await expect(file.code).toMatchFileSnapshot(`__snapshots__/swift/${example.id}.swift`)
      if (swift) expect(runChecker({ 'Mapping.swift': file.code }, 'swiftc', () => ['-parse', 'Mapping.swift'])).toBe('')
    }, 60000)
  }
})
