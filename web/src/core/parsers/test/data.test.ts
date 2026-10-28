// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { detectFormat, parseInput } from '../registry.ts'
import { fieldsOf, parseOk } from './helpers.ts'

describe('JSON', () => {
  it('infers models, optional and nullable fields from an example', () => {
    const { schema } = parseOk(
      JSON.stringify({
        id: 7,
        name: 'Raúl Estévez',
        price: 9.5,
        createdAt: '2026-01-15T10:00:00Z',
        birthDate: '1990-04-02',
        token: '3f1c2e9a-5b7d-4c1e-9f00-1a2b3c4d5e6f',
        address: { city: 'Villaluna', zip: '01234' },
        items: [
          { sku: 'A1', qty: 2, note: null },
          { sku: 'B2', qty: 1, note: 'gift' },
          { sku: 'C3', qty: 1 },
        ],
        tags: ['new'],
      }),
      'json',
      { rootName: 'Order' },
    )
    expect(schema.root).toBe('Order')
    expect(schema.models.map((model) => model.name)).toEqual(['Order', 'Address', 'Item'])
    expect(fieldsOf(schema, 'Order')).toEqual([
      'id: integer',
      'name: string',
      'price: float',
      'createdAt: datetime',
      'birthDate: date',
      'token: uuid',
      'address: Address',
      'items: Item[]',
      'tags: string[]',
    ])
    expect(fieldsOf(schema, 'Item')).toEqual(['sku: string', 'qty: integer', 'note?: string | null'])
  })

  it('uses the items of a root list, named in singular', () => {
    const { schema } = parseOk('[{"id": 1}, {"id": 2, "extra": true}]', 'json', { rootName: 'Users' })
    expect(schema.root).toBe('User')
    expect(fieldsOf(schema, 'User')).toEqual(['id: integer', 'extra?: boolean'])
  })

  it('reports where the JSON is wrong', () => {
    const outcome = parseInput('{\n  "a": 1,\n}', 'json')
    expect(outcome).toMatchObject({ ok: false, error: { code: 'syntax', line: 3, column: 1, params: { detail: 'json.trailingComma' } } })
  })

  it('warns about mixed types and rejects documents without objects', () => {
    const outcome = parseOk('[{"v": 1}, {"v": "x"}]', 'json')
    expect(outcome.warnings).toEqual([{ code: 'mixedTypes', params: { field: 'v' } }])
    expect(parseInput('[1, 2]', 'json')).toMatchObject({ ok: false, error: { code: 'noModels' } })
    expect(parseInput('   ', 'json')).toMatchObject({ ok: false, error: { code: 'empty' } })
  })
})

describe('YAML', () => {
  it('reads a document as an example', () => {
    const { schema } = parseOk('id: 1\nname: Ana\nroles:\n  - admin\nprofile:\n  active: true\n', 'yaml', { rootName: 'User' })
    expect(fieldsOf(schema, 'User')).toEqual(['id: integer', 'name: string', 'roles: string[]', 'profile: Profile'])
  })

  it('reports syntax errors with their position', () => {
    const outcome = parseInput('a: 1\n b: [\n', 'yaml')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.code).toBe('syntax')
  })
})

describe('XML', () => {
  it('reads attributes, children and repeated elements', () => {
    const { schema } = parseOk(
      '<?xml version="1.0"?><order id="5"><customer><name>Ana</name></customer><items><item><sku>A</sku></item></items><total>12.5</total></order>',
      'xml',
    )
    expect(schema.root).toBe('Order')
    expect(fieldsOf(schema, 'Order')).toEqual(['id: integer', 'customer: Customer', 'items: Item[]', 'total: float'])
  })

  it('reports malformed XML', () => {
    expect(parseInput('<a><b></a>', 'xml')).toMatchObject({ ok: false, error: { code: 'syntax' } })
  })
})

describe('CSV', () => {
  it('infers column types and keeps codes with leading zeros as text', () => {
    const { schema } = parseOk('id;name;zip;active;amount\n1;Ana;01234;true;3.5\n2;Luis;;false;\n', 'csv', { rootName: 'Customer' })
    expect(fieldsOf(schema, 'Customer')).toEqual([
      'id: integer',
      'name: string',
      'zip: string | null',
      'active: boolean',
      'amount: float | null',
    ])
  })

  it('handles quoted fields and an empty column', () => {
    const { schema } = parseOk('"name","note"\n"Ana, López",""\n', 'csv')
    expect(fieldsOf(schema, 'Row')).toEqual(['name: string', 'note: string | null'])
  })

  it('reports an unterminated quote', () => {
    expect(parseInput('a,b\n"x,1\n', 'csv')).toMatchObject({ ok: false, error: { code: 'unterminatedString', line: 2 } })
  })
})

describe('detection', () => {
  it('recognizes each data format', () => {
    expect(detectFormat('{"a": 1}')).toBe('json')
    expect(detectFormat('a: 1\nb: two\n')).toBe('yaml')
    expect(detectFormat('<root><a>1</a></root>')).toBe('xml')
    expect(detectFormat('a,b,c\n1,2,3\n4,5,6')).toBe('csv')
    expect(detectFormat('anything', 'data.yml')).toBe('yaml')
  })
})
