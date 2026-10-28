import { describe, expect, it } from 'vitest'
import { assignable, compatibility } from './compatibility.ts'
import { nameWords, singularize, toCamelCase, toPascalCase, toScreamingSnakeCase, toSnakeCase } from './naming.ts'
import { allFields, defaultRoot, describeType, emptySchema, needsValue, primitive, type FieldDef, type ModelSchema } from './schema.ts'

const field = (name: string, overrides: Partial<FieldDef> = {}): FieldDef => ({
  name,
  type: primitive('string'),
  nullable: false,
  optional: false,
  ...overrides,
})

describe('naming', () => {
  it('splits every convention into the same words', () => {
    for (const name of ['userId', 'user_id', 'UserId', 'userID', 'user-id', 'USER_ID']) expect(nameWords(name)).toEqual(['user', 'id'])
  })

  it('converts between conventions', () => {
    expect(toPascalCase('created_at')).toBe('CreatedAt')
    expect(toCamelCase('created_at')).toBe('createdAt')
    expect(toSnakeCase('createdAt')).toBe('created_at')
    expect(toScreamingSnakeCase('inProgress')).toBe('IN_PROGRESS')
  })

  it('singularizes plurals', () => {
    expect(singularize('items')).toBe('item')
    expect(singularize('addresses')).toBe('address')
    expect(singularize('status')).toBe('status')
  })
})

describe('compatibility', () => {
  const string = primitive('string')
  const int = primitive('integer')
  it('accepts the same type and widenings', () => {
    expect(compatibility(string, string).level).toBe('same')
    expect(compatibility(primitive('integer', 32), primitive('integer', 64)).level).toBe('widening')
    expect(compatibility(int, primitive('float')).level).toBe('widening')
    expect(compatibility(primitive('date'), primitive('datetime')).level).toBe('widening')
  })

  it('marks parsing as a fallible conversion and narrowing as lossy', () => {
    expect(compatibility(string, int)).toEqual({ level: 'conversion', fallible: true })
    expect(compatibility(primitive('integer', 64), primitive('integer', 32))).toEqual({ level: 'conversion', lossy: true })
    expect(compatibility(primitive('float'), int)).toEqual({ level: 'conversion', lossy: true })
    expect(compatibility(int, string).level).toBe('conversion')
  })

  it('asks for a transformation when the meaning is not obvious', () => {
    expect(compatibility(string, primitive('boolean')).level).toBe('transform')
    expect(compatibility(int, primitive('datetime')).level).toBe('transform')
    expect(compatibility({ kind: 'enum', name: 'A' }, { kind: 'enum', name: 'B' }).level).toBe('transform')
  })

  it('relates models, collections and incompatible shapes', () => {
    expect(compatibility({ kind: 'model', name: 'A' }, { kind: 'model', name: 'B' }).level).toBe('nested')
    const items = compatibility(
      { kind: 'array', items: { kind: 'model', name: 'A' } },
      { kind: 'array', items: { kind: 'model', name: 'B' } },
    )
    expect(items).toEqual({ level: 'collection', items: { level: 'nested' } })
    expect(assignable(items)).toBe(true)
    expect(compatibility({ kind: 'array', items: string }, string).level).toBe('incompatible')
    expect(compatibility({ kind: 'model', name: 'A' }, int).level).toBe('incompatible')
    expect(assignable(compatibility({ kind: 'array', items: string }, { kind: 'array', items: primitive('boolean') }))).toBe(false)
  })

  it('converts enums to and from text', () => {
    expect(compatibility({ kind: 'enum', name: 'Status' }, string)).toEqual({ level: 'conversion' })
    expect(compatibility(string, { kind: 'enum', name: 'Status' })).toEqual({ level: 'conversion', fallible: true })
  })
})

describe('schema helpers', () => {
  const schema: ModelSchema = {
    ...emptySchema(),
    models: [
      { name: 'Address', kind: 'class', fields: [field('city')] },
      { name: 'Base', kind: 'class', fields: [field('id', { type: primitive('integer') }), field('name')] },
      {
        name: 'User',
        kind: 'class',
        extends: ['Base'],
        fields: [field('name', { nullable: true }), field('address', { type: { kind: 'model', name: 'Address' } })],
      },
    ],
  }

  it('includes inherited fields, the child winning', () => {
    const user = schema.models[2]
    expect(allFields(schema, user).map((item) => [item.name, item.nullable])).toEqual([
      ['id', false],
      ['name', true],
      ['address', false],
    ])
  })

  it('picks as root a model no other model refers to', () => {
    expect(defaultRoot(schema)).toBe('Base')
    expect(defaultRoot({ ...schema, root: 'User' })).toBe('User')
  })

  it('knows which fields need a value', () => {
    expect(needsValue(field('a'))).toBe(true)
    expect(needsValue(field('a', { optional: true }))).toBe(false)
    expect(needsValue(field('a', { defaultValue: '' }))).toBe(false)
    expect(needsValue(field('a', { generated: true }))).toBe(false)
  })

  it('describes types', () => {
    expect(describeType({ kind: 'array', items: primitive('integer', 32), itemsNullable: true })).toBe('(integer32 | null)[]')
    expect(describeType({ kind: 'map', key: primitive('string'), value: { kind: 'model', name: 'A' } })).toBe('map<string, A>')
  })
})
