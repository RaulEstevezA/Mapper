import { describe, expect, it } from 'vitest'
import { suggestMapping } from '../../matching/engine.ts'
import { setTransform } from '../../mapping/edit.ts'
import { parseInput } from '../../parsers/registry.ts'
import { goGenerator } from '../languages/go.ts'
import { kotlinGenerator } from '../languages/kotlin.ts'
import { rustGenerator } from '../languages/rust.ts'
import { typeScriptGenerator } from '../languages/typescript.ts'
import { buildPlan } from '../plan.ts'
import type { CodeGenerator } from '../types.ts'

const SOURCE = '{ "cents": 152340, "name": "Ana", "delta": -3 }'
const TARGET = `data class Invoice(
    val total: java.math.BigDecimal,
    val half: Double,
    val size: Long,
    val gap: Long,
    val small: Long,
)`
const EXPRESSIONS: Record<string, string> = {
  total: 'cents > 0 ? round(cents / 100) : 0',
  half: 'cents / 2',
  size: 'length(name) + 1',
  gap: 'abs(delta)',
  small: 'min(cents, 10)',
}

/** The code each target field gets, with every field written as an expression. */
function lines(generator: CodeGenerator): string {
  const source = parseInput(SOURCE, 'json', { rootName: 'InvoiceResponse' })
  const target = parseInput(TARGET, 'kotlin', { rootName: 'Invoice' })
  if (!source.ok || !target.ok) throw new Error('The models do not parse')
  let set = suggestMapping(source.schema, 'InvoiceResponse', target.schema, 'Invoice')
  const id = set.mappings[0].id
  for (const [field, expression] of Object.entries(EXPRESSIONS)) set = setTransform(set, id, field, { kind: 'expression', expression })
  const plan = buildPlan(set, source.schema, target.schema)!
  return generator.generate(plan, { mode: generator.modes[0], naming: 'auto', options: {} }).files[0].code
}

// Expressions are written with the types of the fields: `/` divides as real numbers and the result
// is converted to the target field (docs/transformations.md)
describe('numbers in expressions', () => {
  it('divides as real numbers and converts the result to the field type (Kotlin)', () => {
    const code = lines(kotlinGenerator)
    expect(code).toContain('total = if (cents > 0L) (round(cents.toDouble() / 100.0)).toBigDecimal() else BigDecimal("0"),')
    expect(code).toContain('half = cents.toDouble() / 2.0,')
    expect(code).toContain('size = (name.length + 1).toLong(),')
    expect(code).toContain('small = minOf(cents, 10L),')
  })

  it('wraps an operation before a method call and keeps integer lengths (Rust)', () => {
    const code = lines(rustGenerator)
    expect(code).toContain('(source.cents as f64 / 100.0).round()')
    expect(code).toContain('size: source.name.chars().count() as i64 + 1,')
    expect(code).toContain('gap: source.delta.abs(),')
  })

  it('types a conditional and takes the absolute value of an integer (Go)', () => {
    const code = lines(goGenerator)
    expect(code).toContain('func() float64 {')
    expect(code).toContain('Gap: max(source.Delta, -source.Delta),')
    expect(code).toContain('Size: int64(len([]rune(source.Name))) + 1,')
  })

  it('leaves JavaScript numbers alone', () => {
    const code = lines(typeScriptGenerator)
    expect(code).toContain('total: source.cents > 0 ? Math.round(source.cents / 100) : 0,')
    expect(code).toContain('half: source.cents / 2,')
  })
})
