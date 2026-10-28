import { describe, expect, it } from 'vitest'
import { findEnum, findModel } from '../../model/schema.ts'
import { detectFormat, parseInput } from '../registry.ts'
import { fieldsOf, parseOk } from './helpers.ts'

describe('TypeScript', () => {
  it('reads interfaces with optional, nullable, array and generic types', () => {
    const { schema } = parseOk(
      `/** A user of the shop */
export interface UserDto extends BaseDto {
  readonly userId: number;
  firstName: string
  lastName?: string;
  email: string | null;
  roles: string[];
  orders: Array<OrderDto>;
  scores: Record<string, number>;
  'display-name': string;
  createdAt: Date;
  getLabel(): string;
  [key: string]: unknown;
}
interface BaseDto { version: number }
interface OrderDto { id: number }`,
      'typescript',
    )
    expect(fieldsOf(schema, 'UserDto')).toEqual([
      'userId: float',
      'firstName: string',
      'lastName?: string',
      'email: string | null',
      'roles: string[]',
      'orders: OrderDto[]',
      'scores: map<string, float>',
      'display-name: string',
      'createdAt: datetime',
    ])
    const user = findModel(schema, 'UserDto')!
    expect(user.extends).toEqual(['BaseDto'])
    expect(user.description).toBe('A user of the shop')
    expect(user.fields[3].originalType).toBe('string | null')
  })

  it('turns literal unions and enums into enums', () => {
    const { schema } = parseOk(
      `type Status = 'PENDING' | 'PAID'
enum Role { Admin = 'admin', User = 'user' }
enum Level { Low = 1, High }
type Order = { status: Status; role: Role; level: Level; kind: 'a' | 'b' | null }`,
      'typescript',
    )
    expect(findEnum(schema, 'Status')?.values.map((value) => value.name)).toEqual(['PENDING', 'PAID'])
    expect(findEnum(schema, 'Role')?.values).toEqual([
      { name: 'Admin', value: 'admin' },
      { name: 'User', value: 'user' },
    ])
    expect(findEnum(schema, 'Level')?.values).toEqual([
      { name: 'Low', value: 1 },
      { name: 'High', value: 2 },
    ])
    expect(fieldsOf(schema, 'Order')).toEqual(['status: Status', 'role: Role', 'level: Level', 'kind: Kind | null'])
  })

  it('names inline object types after their field', () => {
    const { schema } = parseOk('interface User { address: { city: string; zip?: string }; tags: { name: string }[] }', 'typescript')
    expect(fieldsOf(schema, 'User')).toEqual(['address: UserAddress', 'tags: UserTags[]'])
    expect(fieldsOf(schema, 'UserAddress')).toEqual(['city: string', 'zip?: string'])
  })

  it('merges intersections and resolves aliases', () => {
    const { schema } = parseOk('type Id = string\ninterface Base { id: Id }\ntype Admin = Base & { level: number }', 'typescript')
    expect(fieldsOf(schema, 'Base')).toEqual(['id: string'])
    expect(findModel(schema, 'Admin')).toMatchObject({ extends: ['Base'] })
    expect(fieldsOf(schema, 'Admin')).toEqual(['level: float'])
  })

  it('reads classes, constructor properties and TypeORM entities', () => {
    const { schema } = parseOk(
      `@Entity('users')
export class User {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ name: 'first_name', nullable: true }) firstName?: string;
  @Column() active = true;
  @CreateDateColumn() createdAt: Date;
  static count = 0;
  #secret = 'x';
  constructor(public readonly tenant: string, other: number) {}
  get label() { return this.firstName }
  save(): void {}
}`,
      'typescript',
    )
    const user = findModel(schema, 'User')!
    expect(user.kind).toBe('entity')
    expect(schema.origin?.framework).toBe('typeorm')
    expect(fieldsOf(schema, 'User')).toEqual([
      'id: float',
      'firstName?: string | null',
      'active: boolean',
      'createdAt: datetime',
      'tenant: string',
    ])
    expect(user.fields[0].generated).toBe(true)
    expect(user.fields[1].serializedName).toBe('first_name')
    expect(user.fields[2].defaultValue).toBe(true)
  })

  it('reports unknown types and unterminated strings', () => {
    const outcome = parseOk('interface A { b: Money }', 'typescript')
    expect(outcome.warnings).toEqual([{ code: 'unknownType', params: { type: 'Money' } }])
    expect(parseInput('interface A { b: "x }', 'typescript')).toMatchObject({ ok: false, error: { code: 'unterminatedString', line: 1 } })
    expect(parseInput('const a = 1', 'typescript')).toMatchObject({ ok: false, error: { code: 'noModels' } })
  })

  it('is detected', () => {
    expect(detectFormat('export interface A {\n  b: string\n}')).toBe('typescript')
    expect(detectFormat('anything', 'user.ts')).toBe('typescript')
  })
})

describe('JavaScript', () => {
  it('reads classes with JSDoc and constructor assignments', () => {
    const { schema } = parseOk(
      `export class User {
  /** @type {string|null} */
  nickname = null
  active = false
  /**
   * @param {number} id
   * @param {string} name
   */
  constructor(id, name) {
    this.id = id
    this.name = name
    this.createdAt = new Date()
  }
}`,
      'javascript',
    )
    expect(fieldsOf(schema, 'User')).toEqual([
      'nickname: string | null',
      'active: boolean',
      'id: float',
      'name: string',
      'createdAt: datetime',
    ])
  })

  it('reads JSDoc typedefs', () => {
    const { schema } = parseOk(
      `/**
 * @typedef {Object} Product
 * @property {string} sku - Stock code
 * @property {number[]} [prices]
 * @property {?string} brand
 */`,
      'javascript',
    )
    expect(fieldsOf(schema, 'Product')).toEqual(['sku: string', 'prices?: float[]', 'brand: string | null'])
    expect(findModel(schema, 'Product')!.fields[0].description).toBe('Stock code')
    expect(detectFormat('/** @typedef {Object} A */')).toBe('javascript')
  })
})
