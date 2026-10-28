import { describe, expect, it } from 'vitest'
import { emptySchema, findEnum, findModel, primitive } from '../../model/schema.ts'
import { detectFormat, parseInput } from '../registry.ts'
import { fieldsOf, parseOk } from './helpers.ts'

describe('GraphQL', () => {
  it('reads types, inputs, enums and nullability', () => {
    const { schema } = parseOk(
      `scalar DateTime
scalar Money

"A user of the shop"
type User implements Node @key(fields: "id") {
  id: ID!
  name: String
  emails: [String!]!
  orders(first: Int): [Order]
  createdAt: DateTime!
  balance: Money
  role: Role!
}

type Order { id: ID! }
input CreateUserInput { name: String!, role: Role = MEMBER }
enum Role { ADMIN MEMBER }
type Query { me: User }`,
      'graphql',
    )
    expect(schema.models.map((model) => model.name)).toEqual(['User', 'Order', 'CreateUserInput'])
    expect(fieldsOf(schema, 'User')).toEqual([
      'id: string',
      'name: string | null',
      'emails: string[]',
      'orders: (Order | null)[] | null',
      'createdAt: datetime',
      'balance: string | null',
      'role: Role',
    ])
    expect(findModel(schema, 'User')!.description).toBe('A user of the shop')
    expect(findModel(schema, 'CreateUserInput')).toMatchObject({ kind: 'input' })
    expect(findModel(schema, 'CreateUserInput')!.fields[1].defaultValue).toBe('MEMBER')
    expect(findEnum(schema, 'Role')!.values.map((value) => value.name)).toEqual(['ADMIN', 'MEMBER'])
    expect(detectFormat('type User {\n  id: ID!\n}')).toBe('graphql')
  })
})

describe('Protocol Buffers', () => {
  it('reads proto3 messages, nested types, maps and enums', () => {
    const { schema } = parseOk(
      `syntax = "proto3";
package shop.v1;
import "google/protobuf/timestamp.proto";

// An order
message Order {
  int64 id = 1;
  string customer_name = 2;
  optional string note = 3;
  repeated Line lines = 4;
  map<string, int32> counters = 5;
  Status status = 6;
  google.protobuf.Timestamp created_at = 7;
  google.protobuf.StringValue coupon = 8;
  Address address = 9;
  oneof payment { string card = 10; string iban = 11; }
  reserved 12;

  message Line { string sku = 1; uint32 quantity = 2; }
}

message Address { string city = 1; }
enum Status { STATUS_UNSPECIFIED = 0; STATUS_PAID = 1; }`,
      'protobuf',
    )
    expect(fieldsOf(schema, 'Order')).toEqual([
      'id: integer64',
      'customer_name: string',
      'note?: string | null',
      'lines: Line[]',
      'counters: map<string, integer32>',
      'status: Status',
      // Well-known types are messages: they may be absent
      'created_at?: datetime | null',
      'coupon?: string | null',
      'address?: Address | null',
      'card?: string | null',
      'iban?: string | null',
    ])
    expect(findModel(schema, 'Order')).toMatchObject({ namespace: 'shop.v1', description: 'An order' })
    expect(fieldsOf(schema, 'Line')).toEqual(['sku: string', 'quantity: integer32'])
    expect(findEnum(schema, 'Status')!.values).toEqual([
      { name: 'STATUS_UNSPECIFIED', value: 0 },
      { name: 'STATUS_PAID', value: 1 },
    ])
    expect(detectFormat('syntax = "proto3";\nmessage A { string b = 1; }')).toBe('protobuf')
  })
})

describe('Prisma', () => {
  it('reads models, relations, defaults and enums', () => {
    const { schema } = parseOk(
      `datasource db { provider = "postgresql" url = env("DATABASE_URL") }

/// A registered user
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  role      Role     @default(MEMBER)
  posts     Post[]
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt

  @@map("users")
}

model Post { id String @id @default(uuid()) title String author User @relation(fields: [authorId], references: [id]) authorId Int }

enum Role {
  ADMIN
  MEMBER @map("member")
}`,
      'prisma',
    )
    expect(fieldsOf(schema, 'User')).toEqual([
      'id?: integer32',
      'email: string',
      'name: string | null',
      'role?: Role',
      'posts: Post[]',
      'createdAt?: datetime',
      'updatedAt: datetime',
    ])
    const user = findModel(schema, 'User')!
    expect(user).toMatchObject({ framework: 'prisma', description: 'A registered user' })
    expect(user.fields[0].generated).toBe(true)
    expect(user.fields[3].defaultValue).toBe('MEMBER')
    expect(user.fields[5]).toMatchObject({ generated: true, serializedName: 'created_at' })
    expect(user.fields[6].generated).toBe(true)
    expect(findEnum(schema, 'Role')!.values).toEqual([{ name: 'ADMIN' }, { name: 'MEMBER', value: 'member' }])
  })
})

describe('Model schema', () => {
  it('accepts a valid document and rejects an invalid one with the path', () => {
    const document = {
      ...emptySchema({ format: 'json', tool: 'api2class' }),
      models: [{ name: 'User', kind: 'object', fields: [{ name: 'id', type: primitive('integer'), nullable: false, optional: false }] }],
    }
    const { schema } = parseOk(JSON.stringify(document), 'modelschema')
    expect(fieldsOf(schema, 'User')).toEqual(['id: integer'])
    expect(detectFormat(JSON.stringify(document))).toBe('modelschema')
    const broken = {
      ...document,
      models: [{ name: 'User', fields: [{ name: 'id', type: { kind: 'weird' }, nullable: false, optional: false }] }],
    }
    expect(parseInput(JSON.stringify(broken), 'modelschema')).toMatchObject({
      ok: false,
      error: { code: 'syntax', params: { path: '$.models[0].fields[0].type' } },
    })
  })
})
