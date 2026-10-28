import { describe, expect, it } from 'vitest'
import { pythonGenerator } from '../languages/python.ts'
import type { GenerateSettings } from '../types.ts'
import { hasCommand, runChecker } from './compile.ts'
import { prepared } from './helpers.ts'

const python = hasCommand('python3')
const settings: GenerateSettings = { mode: 'functions', naming: 'auto', options: {} }

describe('Python generator', () => {
  for (const { example, plan } of prepared()) {
    it(`generates valid Python: ${example.id}`, async () => {
      const code = pythonGenerator.generate(plan, settings).files[0].code
      await expect(code).toMatchFileSnapshot(`__snapshots__/python/${example.id}.py`)
      if (python) expect(runChecker({ 'mapper.py': code }, 'python3', () => ['-m', 'py_compile', 'mapper.py'])).toBe('')
    })
  }

  it('reads documents as dictionaries by default', () => {
    const { plan } = prepared()[1]
    const code = pythonGenerator.generate(plan, settings).files[0].code
    expect(code).toContain('source["given_name"]')
    expect(code).toContain('date.fromisoformat(source["dob"])')
  })
})
