import { describe, expect, it } from 'vitest'
import { checkExpression, parseExpression, type ValueKind } from './expression.ts'

const kinds: Record<string, ValueKind> = {
  firstName: 'string',
  lastName: 'string',
  price: 'number',
  'address.city': 'string',
  active: 'boolean',
}
const fieldKind = (path: string[]) => kinds[path.join('.')] ?? null

function check(text: string) {
  const parsed = parseExpression(text)
  if (!parsed.ok) return parsed.error
  return checkExpression(parsed.expr, fieldKind)
}

describe('expression language', () => {
  it('parses with precedence and lists the fields used', () => {
    const parsed = parseExpression('price * 1.21 + 2')
    expect(parsed.ok && parsed.expr).toEqual({
      kind: 'binary',
      operator: '+',
      left: { kind: 'binary', operator: '*', left: { kind: 'field', path: ['price'] }, right: { kind: 'literal', value: 1.21 } },
      right: { kind: 'literal', value: 2 },
    })
    const fields = parseExpression('concat(firstName, " ", source.lastName, address.city, firstName)')
    expect(fields.ok && fields.fields).toEqual([['firstName'], ['lastName'], ['address', 'city']])
  })

  it('types expressions', () => {
    expect(check('upper(trim(firstName)) + " " + lastName')).toEqual({ kind: 'string' })
    expect(check('price > 100 ? "big" : "small"')).toEqual({ kind: 'string' })
    expect(check('round(price / 100)')).toEqual({ kind: 'number' })
    expect(check('active && price >= 0')).toEqual({ kind: 'boolean' })
    expect(check('address.city ?? "Unknown"')).toEqual({ kind: 'string' })
    expect(check('-price')).toEqual({ kind: 'number' })
  })

  it('reports errors with their position', () => {
    expect(check('')).toEqual({ code: 'empty', column: 1 })
    expect(check('price +')).toEqual({ code: 'unexpectedToken', column: 8, params: { found: 'end' } })
    expect(check('"open')).toEqual({ code: 'unterminatedString', column: 1 })
    expect(check('eval(x)')).toEqual({ code: 'unknownFunction', column: 1, params: { name: 'eval' } })
    expect(check('upper()')).toEqual({ code: 'argumentCount', column: 1, params: { name: 'upper', count: 1 } })
    expect(check('price + firstName')).toMatchObject({ error: { code: 'typeMismatch' } })
    expect(check('missing + 1')).toMatchObject({ error: { code: 'unknownField', params: { field: 'missing' } } })
    expect(check('price ; drop')).toEqual({ code: 'unexpectedToken', column: 7, params: { found: ';' } })
    expect(check('('.repeat(100) + '1' + ')'.repeat(100))).toMatchObject({ code: 'tooComplex' })
  })

  it('never treats text as code', () => {
    // Anything that is not the grammar is an error, not something to run
    for (const text of ['window.alert(1)', 'constructor.constructor("x")()', '`x`', 'a = 1', 'x => x', '[1]']) {
      const parsed = parseExpression(text)
      if (parsed.ok) expect(checkExpression(parsed.expr, fieldKind)).toHaveProperty('error')
    }
  })
})
