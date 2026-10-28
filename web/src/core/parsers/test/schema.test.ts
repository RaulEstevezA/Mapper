import { describe, expect, it } from 'vitest'
import { findEnum, findModel } from '../../model/schema.ts'
import { detectFormat } from '../registry.ts'
import { fieldsOf, parseOk } from './helpers.ts'

const JSON_SCHEMA = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Customer',
  type: 'object',
  required: ['id', 'email'],
  properties: {
    id: { type: 'integer', format: 'int64' },
    email: { type: 'string', description: 'Contact address' },
    nickname: { type: ['string', 'null'] },
    status: { enum: ['active', 'blocked'] },
    address: { $ref: '#/$defs/Address' },
    tags: { type: 'array', items: { type: 'string' } },
    scores: { type: 'object', additionalProperties: { type: 'number' } },
    createdAt: { type: 'string', format: 'date-time', readOnly: true },
  },
  $defs: {
    Address: { type: 'object', required: ['city'], properties: { city: { type: 'string' }, country: { type: 'string', default: 'ES' } } },
  },
})

describe('JSON Schema', () => {
  it('converts properties, references, enums and formats', () => {
    const { schema } = parseOk(JSON_SCHEMA, 'jsonschema')
    expect(schema.root).toBe('Customer')
    expect(fieldsOf(schema, 'Customer')).toEqual([
      'id: integer64',
      'email: string',
      'nickname?: string | null',
      'status?: Status',
      'address?: Address',
      'tags?: string[]',
      'scores?: map<string, float>',
      'createdAt?: datetime',
    ])
    expect(findEnum(schema, 'Status')?.values.map((value) => value.name)).toEqual(['active', 'blocked'])
    expect(findModel(schema, 'Address')?.fields[1].defaultValue).toBe('ES')
    expect(findModel(schema, 'Customer')?.fields[1].description).toBe('Contact address')
    expect(findModel(schema, 'Customer')?.fields[7].generated).toBe(true)
  })

  it('is detected by its $schema', () => {
    expect(detectFormat(JSON_SCHEMA)).toBe('jsonschema')
  })
})

describe('OpenAPI', () => {
  const yaml = `openapi: 3.0.3
info: { title: Shop, version: '1' }
paths: {}
components:
  schemas:
    Pet:
      type: object
      required: [id, name]
      properties:
        id: { type: integer, format: int64 }
        name: { type: string }
        tag: { type: string, nullable: true }
        owner: { $ref: '#/components/schemas/Owner' }
    Owner:
      type: object
      properties:
        id: { type: string, format: uuid }
    Dog:
      allOf:
        - $ref: '#/components/schemas/Pet'
        - type: object
          properties:
            breed: { type: string }
`

  it('reads the component schemas, with inheritance through allOf', () => {
    const { schema } = parseOk(yaml, 'openapi')
    expect(schema.models.map((model) => model.name)).toEqual(['Pet', 'Owner', 'Dog'])
    expect(fieldsOf(schema, 'Pet')).toEqual(['id: integer64', 'name: string', 'tag?: string | null', 'owner?: Owner'])
    expect(findModel(schema, 'Dog')?.extends).toEqual(['Pet'])
    expect(detectFormat(yaml)).toBe('openapi')
  })

  it('reads Swagger 2 definitions', () => {
    const { schema } = parseOk(
      JSON.stringify({
        swagger: '2.0',
        definitions: { User: { type: 'object', properties: { id: { type: 'integer', 'x-nullable': true } } } },
      }),
      'openapi',
    )
    expect(fieldsOf(schema, 'User')).toEqual(['id?: integer | null'])
  })
})
