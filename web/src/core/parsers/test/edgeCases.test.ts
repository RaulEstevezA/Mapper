// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseInput, parsers } from '../registry.ts'
import { fieldsOf, parseOk } from './helpers.ts'

// Deterministic pseudo-random text, so a failure can be reproduced
function randomText(seed: number, length: number): string {
  const alphabet = 'abcXYZ019 _:;,.{}[]()<>?!=@#$"\'`\n\t/*-+|&\\'
  let state = seed
  let text = ''
  for (let index = 0; index < length; index++) {
    state = (state * 1103515245 + 12345) % 2147483648
    text += alphabet[state % alphabet.length]
  }
  return text
}

const SAMPLES: Record<string, string> = {
  typescript: 'interface A { b: string; c?: number[] }',
  python: 'class A:\n    b: str\n    c: list[int] = []\n',
  java: 'public class A { private String b; private List<Integer> c; }',
  csharp: 'public class A { public string B { get; set; } }',
  kotlin: 'data class A(val b: String, val c: List<Int>)',
  dart: 'class A { final String b; A({required this.b}); }',
  swift: 'struct A: Codable { let b: String }',
  go: 'type A struct {\n\tB string `json:"b"`\n}',
  rust: 'pub struct A { pub b: String }',
  php: '<?php class A { public string $b; }',
  graphql: 'type A { b: String! }',
  protobuf: 'syntax = "proto3"; message A { string b = 1; }',
  prisma: 'model A { id Int @id\n b String }',
  scala: 'final case class A(b: String, c: Option[Int] = None)',
  smithy: '$version: "2"\nnamespace a\nstructure A { @required b: String }',
}

describe('every parser', () => {
  it('never throws on random or truncated input', () => {
    for (const parser of parsers) {
      for (let seed = 1; seed <= 40; seed++) {
        expect(() => parser.parse(randomText(seed * 7919, 20 + seed * 5)), `${parser.id} seed ${seed}`).not.toThrow()
      }
      const sample = SAMPLES[parser.id]
      if (sample) {
        for (let cut = 1; cut < sample.length; cut += 3)
          expect(() => parser.parse(sample.slice(0, cut)), `${parser.id} cut ${cut}`).not.toThrow()
      }
    }
  })

  it('reports empty input the same way', () => {
    for (const parser of parsers) expect(parseInput('  \n ', parser.id)).toEqual({ ok: false, error: { code: 'empty' } })
  })
})

describe('edge cases', () => {
  it('warns about repeated fields and keeps the first', () => {
    const outcome = parseOk('interface A { b: string; b: number }', 'typescript')
    expect(fieldsOf(outcome.schema, 'A')).toEqual(['b: string'])
    expect(outcome.warnings).toContainEqual({ code: 'duplicateField', params: { model: 'A', field: 'b' } })
  })

  it('keeps classes without fields', () => {
    const { schema } = parseOk('class Marker:\n    pass\n\nclass Other:\n    name: str\n', 'python')
    expect(schema.models.map((model) => model.name)).toEqual(['Marker', 'Other'])
  })

  it('reads large models quickly', () => {
    const fields = Array.from({ length: 3000 }, (_, index) => `  field${index}: ${index % 2 ? 'string' : 'number[]'};`).join('\n')
    const start = performance.now()
    const { schema } = parseOk(`interface Big {\n${fields}\n}`, 'typescript')
    expect(schema.models[0].fields).toHaveLength(3000)
    expect(performance.now() - start).toBeLessThan(1000)
    const json = JSON.stringify(
      Array.from({ length: 2000 }, (_, index) => ({ id: index, name: `n${index}`, tags: ['a'], nested: { value: index * 1.5 } })),
    )
    expect(parseOk(json, 'json').schema.models).toHaveLength(2)
  })

  it('reports nested arrays and unknown types', () => {
    const { schema, warnings } = parseOk('interface A { grid: number[][]; money: Money }', 'typescript')
    expect(fieldsOf(schema, 'A')).toEqual(['grid: float[][]', 'money: Money'])
    expect(warnings).toEqual([{ code: 'unknownType', params: { type: 'Money' } }])
  })
})
