import { describe, expect, it } from 'vitest'
import { cSharpGenerator } from '../languages/csharp.ts'
import { prepared } from './helpers.ts'

describe('C# generator', () => {
  for (const { example, plan } of prepared()) {
    it(`writes extension methods: ${example.id}`, async () => {
      const code = cSharpGenerator.generate(plan, { mode: 'manual', naming: 'auto', options: {} }).files[0].code
      await expect(code).toMatchFileSnapshot(`__snapshots__/csharp/${example.id}.cs`)
      expect(code).toContain('ArgumentNullException.ThrowIfNull(source);')
    })

    it(`writes an AutoMapper profile: ${example.id}`, async () => {
      const code = cSharpGenerator.generate(plan, { mode: 'automapper', naming: 'auto', options: {} }).files[0].code
      await expect(code).toMatchFileSnapshot(`__snapshots__/csharp-automapper/${example.id}.cs`)
      // Expression trees cannot hold null-conditional operators
      expect(code).not.toContain('?.')
    })
  }
})
