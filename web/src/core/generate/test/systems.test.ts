import { describe, expect, it } from 'vitest'
import { generators } from '../generators.ts'
import { goGenerator } from '../languages/go.ts'
import { phpGenerator } from '../languages/php.ts'
import { rustGenerator } from '../languages/rust.ts'
import type { GenerateSettings } from '../types.ts'
import { hasCommand, runChecker } from './compile.ts'
import { buildPlan } from '../plan.ts'
import { prepare, prepared } from './helpers.ts'

const php = hasCommand('php', ['-v'])
const rustfmt = hasCommand('rustfmt')
const settings = (mode: string): GenerateSettings => ({ mode, naming: 'auto', options: {} })

describe('PHP generator', () => {
  for (const { example, plan } of prepared()) {
    it(`writes valid PHP: ${example.id}`, async () => {
      const file = phpGenerator.generate(plan, settings('static')).files[0]
      await expect(file.code).toMatchFileSnapshot(`__snapshots__/php/${example.id}.php`)
      if (php) expect(runChecker({ 'Mapper.php': file.code }, 'php', () => ['-l', 'Mapper.php'])).toBe('')
    })
  }
})

describe('Rust generator', () => {
  for (const { example, plan } of prepared()) {
    it(`writes valid Rust: ${example.id}`, async () => {
      const file = rustGenerator.generate(plan, settings('from')).files[0]
      await expect(file.code).toMatchFileSnapshot(`__snapshots__/rust/${example.id}.rs`)
      if (rustfmt)
        expect(runChecker({ 'mapping.rs': file.code }, 'rustfmt', () => ['--edition', '2021', '--emit', 'stdout', 'mapping.rs'])).toBe('')
    })
  }
})

describe('Go generator', () => {
  for (const { example, plan } of prepared()) {
    it(`writes Go functions: ${example.id}`, async () => {
      const code = goGenerator.generate(plan, settings('functions')).files[0].code
      await expect(code).toMatchFileSnapshot(`__snapshots__/go/${example.id}.go`)
      expect(code).toMatch(/^package \w+/)
    })
  }
})

describe('every generator', () => {
  it('handles a mapping left without suggestions (placeholders, no crash)', () => {
    const empty = prepare(prepared()[0].example, false)
    for (const mapping of empty.set.mappings) for (const field of mapping.fields) field.status = 'unmapped'
    const plan = buildPlan(empty.set, empty.source, empty.target)!
    expect(plan.root.assignments.every((assignment) => assignment.missing)).toBe(true)
    for (const generator of generators) {
      for (const mode of generator.modes) {
        const output = generator.generate(plan, { mode, naming: 'auto', options: {} })
        expect(
          output.notes.some((note) => note.code === 'missingValue'),
          `${generator.id} ${mode}`,
        ).toBe(true)
        expect(output.files[0].code.length, `${generator.id} ${mode}`).toBeGreaterThan(0)
      }
    }
  })
})
