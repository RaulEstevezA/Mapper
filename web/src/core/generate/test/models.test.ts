import { describe, expect, it } from 'vitest'
import { suggestMapping } from '../../matching/engine.ts'
import { parseInput } from '../../parsers/registry.ts'
import { EXAMPLES } from '../../../examples/index.ts'
import { reachable } from '../../../app/workspace.ts'
import { DRAFT_FORMATS, draftName, draftTarget } from '../models.ts'
import { hasCommand, runChecker } from './compile.ts'

const python = hasCommand('python3')

describe('target drafts', () => {
  it('names the new model after the source without its role suffix', () => {
    expect(draftName('UserDto')).toBe('User')
    expect(draftName('OrderApi')).toBe('Order')
    expect(draftName('ProductResponse')).toBe('Product')
    expect(draftName('Source')).toBe('Target')
    expect(draftName('Customer')).toBe('Customer')
  })

  for (const example of EXAMPLES) {
    for (const format of DRAFT_FORMATS) {
      it(`writes a ${format} target from the ${example.id} example that maps back completely`, async () => {
        const source = parseInput(example.source.text, example.source.format, { rootName: example.source.model })
        if (!source.ok) throw new Error('source')
        const draft = draftTarget(source.schema, example.source.model, format)!
        await expect(draft.text).toMatchFileSnapshot(
          `__snapshots__/drafts/${example.id}.${format === 'jsonschema' ? 'schema.json' : { typescript: 'ts', python: 'py', kotlin: 'kt', java: 'java', csharp: 'cs' }[format]}`,
        )
        // Read back with Mapper's own parser
        const target = parseInput(draft.text, format)
        if (!target.ok) throw new Error(JSON.stringify(target.error))
        expect(target.warnings).toEqual([])
        // Every field of the new model finds its source by itself
        const set = suggestMapping(source.schema, example.source.model, target.schema, draft.model)
        const fields = reachable(set).flatMap((mapping) => mapping.fields)
        expect(fields.length).toBeGreaterThan(0)
        expect(fields.filter((field) => field.status !== 'active').map((field) => `${field.target}: ${field.status}`)).toEqual([])
        if (format === 'python' && python)
          expect(runChecker({ 'models.py': draft.text }, 'python3', () => ['-m', 'py_compile', 'models.py'])).toBe('')
      })
    }
  }
})
