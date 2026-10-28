import { describe, expect, it } from 'vitest'
import { parseInput } from '../parsers/registry.ts'
import type { InputFormatId } from '../parsers/types.ts'
import { findMapping, pathKey, type FieldMapping, type MappingSet } from '../mapping/types.ts'
import type { ModelSchema } from '../model/schema.ts'
import { coverage, suggestMapping } from './engine.ts'
import { compareNames } from './names.ts'

function schema(text: string, format: InputFormatId = 'typescript'): ModelSchema {
  const outcome = parseInput(text, format)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
  return outcome.schema
}

function map(
  source: string,
  sourceModel: string,
  target: string,
  targetModel: string,
  sourceFormat: InputFormatId = 'typescript',
  targetFormat: InputFormatId = 'typescript',
) {
  const sourceSchema = schema(source, sourceFormat)
  const targetSchema = schema(target, targetFormat)
  const set = suggestMapping(sourceSchema, sourceModel, targetSchema, targetModel)
  return { set, sourceSchema, targetSchema }
}

/** `target ← source [confidence, status]` lines, for readable expectations. */
function summary(set: MappingSet, id = set.root): string[] {
  const mapping = findMapping(set, id)!
  return mapping.fields.map((field: FieldMapping) => {
    const sources = field.sources.map((path) => (path.length === 0 ? '(root)' : pathKey(path))).join(' + ')
    const transform = field.transform.kind === 'direct' ? '' : ` (${field.transform.kind})`
    return `${field.target} ← ${sources || '-'}${transform} [${field.confidence}, ${field.status}]`
  })
}

describe('name comparison', () => {
  const none = { sourceModel: [], targetModel: [] }
  it('scores conventions, abbreviations and synonyms', () => {
    expect(compareNames('email', ['email'], 'email', none)).toEqual({ score: 1, reason: 'sameName' })
    for (const name of ['user_id', 'UserId', 'userID'])
      expect(compareNames(name, name === 'user_id' ? ['user', 'id'] : ['user', 'id'], 'userId', none)?.reason).toBe('sameWords')
    expect(compareNames('qty', ['qty'], 'quantity', none)?.reason).toBe('abbreviation')
    expect(compareNames('surname', ['surname'], 'last_name', none)?.reason).toBe('abbreviation')
    expect(compareNames('creationDate', ['creation', 'date'], 'created_at', none)?.reason).toBe('synonym')
    expect(compareNames('dob', ['dob'], 'birthDate', none)?.reason).toBe('abbreviation')
    expect(compareNames('id', ['id'], 'userId', { sourceModel: [], targetModel: ['user'] })).toEqual({ score: 0.9, reason: 'modelContext' })
    expect(compareNames('color', ['color'], 'price', none)).toBeNull()
  })
})

describe('matching engine', () => {
  it('matches exact names and naming conventions, with automatic conversions', () => {
    const { set } = map(
      'interface UserDto { userId: number; emailAddress: string; createdAt: string; age: string; legacyCode: string }',
      'UserDto',
      'class User:\n    id: int\n    email: str\n    created_at: datetime\n    age: int\n',
      'User',
      'typescript',
      'python',
    )
    expect(summary(set)).toEqual([
      // TypeScript `number` into a Python int may lose decimals: likely, not certain
      'id ← userId [probable, active]',
      'email ← emailAddress [high, active]',
      'created_at ← createdAt [high, active]',
      'age ← age [high, active]',
    ])
    const root = findMapping(set, set.root)!
    expect(root.fields[3].reasons).toContainEqual({ code: 'typeFallible' })
  })

  it('uses synonyms and abbreviations', () => {
    const { set } = map(
      'interface A { surname: string; qty: number; dob: Date; mail: string }',
      'A',
      'interface B { last_name: string; quantity: number; birth_date: Date; email: string }',
      'B',
    )
    expect(summary(set)).toEqual([
      'last_name ← surname [high, active]',
      'quantity ← qty [high, active]',
      'birth_date ← dob [high, active]',
      'email ← mail [high, active]',
    ])
  })

  it('does not relate similar names with incompatible types', () => {
    const { set } = map(
      'interface A { address: { city: string }; tags: string[] }',
      'A',
      'interface B { address: string; tags: string }',
      'B',
    )
    // The object itself cannot become text: only one of its fields is offered, for review
    expect(summary(set)).toEqual(['address ← address.city [review, pending]', 'tags ← - [none, unmapped]'])
  })

  it('shows an ambiguity instead of choosing', () => {
    const { set } = map('interface A { name: string; title: string }', 'A', 'interface B { label: string }', 'B')
    const [label] = findMapping(set, set.root)!.fields
    expect(label.status).toBe('pending')
    expect(label.confidence).toBe('conflict')
    expect(label.candidates!.map((candidate) => pathKey(candidate.sources[0]))).toEqual(expect.arrayContaining(['name', 'title']))
  })

  it('marks one source wanted by several targets as a conflict', () => {
    const { set } = map('interface A { username: string }', 'A', 'interface B { user_name: string; login: string }', 'B')
    expect(summary(set)).toEqual(['user_name ← username [high, active]', 'login ← - [none, unmapped]'])
    const { set: second } = map('interface A { name: string }', 'A', 'interface B { title: string; label: string }', 'B')
    expect(summary(second)).toEqual(['title ← name [conflict, pending]', 'label ← name [conflict, pending]'])
  })

  it('maps nested objects with their own mapping, and flattens nested fields', () => {
    const { set } = map(
      'interface OrderApi { id: number; customer: CustomerApi; shipping: { city: string; country: string } }\ninterface CustomerApi { id: number; fullName: string }',
      'OrderApi',
      'interface Order { id: number; customer: Customer; customer_id: number; city: string }\ninterface Customer { id: number; full_name: string }',
      'Order',
    )
    expect(summary(set)).toEqual([
      'id ← id [exact, active]',
      'customer ← customer (object) [exact, active]',
      'customer_id ← customer.id [high, active]',
      'city ← shipping.city [probable, active]',
    ])
    const customer = findMapping(set, set.root)!.fields[1]
    expect(customer.transform).toEqual({ kind: 'object', mapping: 'CustomerApi->Customer' })
    expect(summary(set, 'CustomerApi->Customer')).toEqual(['id ← id [exact, active]', 'full_name ← fullName [high, active]'])
  })

  it('rebuilds a nested target from a flat source', () => {
    const { set } = map(
      'interface Flat { name: string; street: string; city: string; zip: string }',
      'Flat',
      'interface Person { name: string; address: Address }\ninterface Address { street: string; city: string; postalCode: string }',
      'Person',
    )
    const address = findMapping(set, set.root)!.fields[1]
    expect(address.sources).toEqual([[]])
    expect(address.transform).toEqual({ kind: 'object', mapping: 'Flat->Address' })
    expect(summary(set, 'Flat->Address')).toEqual([
      'street ← street [exact, active]',
      'city ← city [exact, active]',
      'postalCode ← zip [high, active]',
    ])
  })

  it('maps collections element by element', () => {
    const { set } = map(
      'interface Cart { items: CartItem[]; tags: string[] }\ninterface CartItem { sku: string; qty: number }',
      'Cart',
      'interface Basket { products: Product[]; tags: string[] }\ninterface Product { sku: string; quantity: number }',
      'Basket',
    )
    const [products, tags] = findMapping(set, set.root)!.fields
    expect(tags).toMatchObject({ sources: [['tags']], transform: { kind: 'collection' }, status: 'active' })
    // `items` and `products` are weak synonyms: suggested, and the elements are mapped
    expect(products).toMatchObject({ sources: [['items']], transform: { kind: 'collection', mapping: 'CartItem->Product' } })
    expect(summary(set, 'CartItem->Product')).toEqual(['sku ← sku [exact, active]', 'quantity ← qty [high, active]'])
  })

  it('combines first and last name, and suggests splitting a full name', () => {
    const { set } = map('interface A { firstName: string; lastName: string }', 'A', 'interface B { fullName: string }', 'B')
    expect(summary(set)).toEqual(['fullName ← firstName + lastName (concat) [high, active]'])
    const { set: split } = map('interface A { fullName: string }', 'A', 'interface B { firstName: string; lastName: string }', 'B')
    expect(summary(split)).toEqual(['firstName ← fullName (split) [review, pending]', 'lastName ← fullName (split) [review, pending]'])
  })

  it('recognizes cents, epochs and statuses', () => {
    const { set, sourceSchema } = map(
      "interface A { price_cents: number; created: number; status: Status }\nenum Status { ACTIVE = 'active', BLOCKED = 'blocked' }",
      'A',
      'interface B { price: number; created: Date; active: boolean }',
      'B',
    )
    expect(sourceSchema.enums).toHaveLength(1)
    const [price, created, active] = findMapping(set, set.root)!.fields
    expect(price).toMatchObject({ transform: { kind: 'arithmetic', operator: '/', operand: 100 }, status: 'active' })
    expect(created).toMatchObject({ transform: { kind: 'epoch', unit: 'seconds' } })
    expect(active).toMatchObject({ sources: [['status']], transform: { kind: 'boolean', trueValues: ['ACTIVE'] }, status: 'pending' })
  })

  it('pairs enum values by name', () => {
    const { set } = map(
      "enum PayState { PENDING = 'pending', PAID = 'paid', REFUNDED = 'refunded' }\ninterface A { state: PayState }",
      'A',
      'enum Status { Pending, Paid, Cancelled }\ninterface B { state: Status }',
      'B',
    )
    expect(findMapping(set, set.root)!.fields[0].transform).toEqual({
      kind: 'enum',
      pairs: [
        { from: 'PENDING', to: 'Pending' },
        { from: 'PAID', to: 'Paid' },
      ],
    })
  })

  it('reports unused source fields and required targets without value', () => {
    const { set, sourceSchema, targetSchema } = map(
      'interface A { id: number; legacy: string }',
      'A',
      'interface B { id: number; createdBy: string; note?: string }',
      'B',
    )
    expect(coverage(findMapping(set, set.root)!, sourceSchema, targetSchema)).toEqual({
      unusedSources: ['legacy'],
      missingRequired: ['createdBy'],
    })
  })

  it('handles recursive models', () => {
    const { set } = map(
      'interface Cat { name: string; children: Cat[] }',
      'Cat',
      'interface Category { name: string; children: Category[] }',
      'Category',
    )
    expect(set.mappings.map((mapping) => mapping.id)).toEqual(['Cat->Category'])
    expect(findMapping(set, set.root)!.fields[1].transform).toEqual({ kind: 'collection', mapping: 'Cat->Category' })
  })
})
