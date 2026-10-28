import { describe, expect, it } from 'vitest'
import { chooseSources, ignoreTarget } from '../core/mapping/edit.ts'
import { findMapping } from '../core/mapping/types.ts'
import type { ModelSchema } from '../core/model/schema.ts'
import { categoryOf, matchesFilter, readInput, reconcile, summarize } from './workspace.ts'

function schemaOf(text: string): ModelSchema {
  const read = readInput({ text, format: null, model: null }, 'source')
  if (!read.outcome?.ok) throw new Error('parse')
  return read.outcome.schema
}

describe('workspace', () => {
  it('detects the format and the model to use', () => {
    const read = readInput({ text: 'interface A { b: string }\ninterface Root { a: A }', format: null, model: null }, 'source')
    expect(read.format).toBe('typescript')
    expect(read.model).toBe('Root')
    expect(readInput({ text: 'interface A { b: string }\ninterface Root { a: A }', format: null, model: 'A' }, 'source').model).toBe('A')
    expect(readInput({ text: '{"a": 1}', format: null, model: null }, 'source').model).toBe('Source')
    expect(readInput({ text: '   ', format: null, model: null }, 'source').outcome).toBeNull()
  })

  it('keeps manual decisions when the input changes', () => {
    const source = schemaOf('interface A { id: number; label: string; extra: string }')
    const target = schemaOf('interface B { id: number; title: string; note?: string }')
    let set = reconcile(null, source, 'A', target, 'B')
    set = chooseSources(set, source, target, set.root, 'title', [['label']])
    set = ignoreTarget(set, set.root, 'note')
    // A field is added to the source: suggestions are recomputed, decisions stay
    const edited = schemaOf('interface A { id: number; label: string; extra: string; note: string }')
    const next = reconcile(set, edited, 'A', target, 'B')
    const fields = findMapping(next, next.root)!.fields
    expect(fields[1]).toMatchObject({ sources: [['label']], manual: true })
    expect(fields[2].status).toBe('ignored')
    // A source field used by a decision disappears: the suggestion comes back
    const removed = schemaOf('interface A { id: number; extra: string }')
    expect(findMapping(reconcile(set, removed, 'A', target, 'B'), set.root)!.fields[1].manual).toBeUndefined()
  })

  it('summarizes and filters fields', () => {
    const source = schemaOf('interface A { id: number; name: string; title: string }')
    const target = schemaOf('interface B { id: number; label: string; created: Date }')
    const set = reconcile(null, source, 'A', target, 'B')
    expect(summarize(set)).toEqual({ total: 3, mapped: 1, review: 0, conflict: 1, unmapped: 1, ignored: 0 })
    const fields = findMapping(set, set.root)!.fields
    expect(fields.map(categoryOf)).toEqual(['mapped', 'conflict', 'unmapped'])
    expect(fields.filter((field) => matchesFilter(field, 'review', '', [], set.root)).map((field) => field.target)).toEqual(['label'])
    expect(fields.filter((field) => matchesFilter(field, 'all', 'crea', [], set.root)).map((field) => field.target)).toEqual(['created'])
  })
})
