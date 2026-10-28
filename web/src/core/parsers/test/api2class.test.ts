import { describe, expect, it } from 'vitest'
import { findEnum, findModel } from '../../model/schema.ts'
import { detectFormat } from '../registry.ts'
import { fieldsOf, parseOk } from './helpers.ts'

/** Shapes of the code Api2Class generates, so its output can be opened in Mapper as it is. */

describe('Api2Class output', () => {
  it('reads Zod schemas', () => {
    const text = `import { z } from 'zod';

export const AddressSchema = z.object({
  city: z.string(),
  zip_code: z.string().nullable(),
});
export type Address = z.infer<typeof AddressSchema>;

export const RootSchema = z.object({
  id: z.number().int(),
  price: z.number(),
  issued_at: z.iso.datetime({ offset: true }),
  notes: z.null(),
  status: z.enum(['active', 'blocked']),
  tags: z.array(z.string()),
  address: AddressSchema,
  extra: z.string().optional(),
  meta: z.record(z.string(), z.number()),
  paid: z.boolean().default(false),
});
export type Root = z.infer<typeof RootSchema>;
`
    const { schema, warnings } = parseOk(text, 'typescript')
    expect(warnings).toEqual([])
    expect(fieldsOf(schema, 'Root')).toEqual([
      'id: integer',
      'price: float',
      'issued_at: string',
      'notes: any | null',
      'status: RootStatus',
      'tags: string[]',
      'address: Address',
      'extra?: string',
      'meta: map<string, float>',
      'paid?: boolean',
    ])
    expect(fieldsOf(schema, 'Address')).toEqual(['city: string', 'zip_code: string | null'])
    expect(findEnum(schema, 'RootStatus')?.values.map((value) => value.name)).toEqual(['active', 'blocked'])
    expect(findModel(schema, 'Root')!.fields[9].defaultValue).toBe(false)
    expect(detectFormat(text)).toBe('typescript')
  })

  it('reads Scala case classes, Scala 3 enums and sealed traits', () => {
    const text = `package shop

import java.time.{LocalDate, OffsetDateTime}
import io.circe.{Decoder, Encoder, Json}

final case class Root(
  invoice_id: String,
  issued_at: OffsetDateTime,
  due_date: LocalDate,
  total_cents: Long,
  notes: Json,
  coupon: Option[String] = None,
  lines: List[Line],
  status: Status
) derives Decoder, Encoder.AsObject

final case class Line(sku: String, qty: Int, price: BigDecimal)

enum Status:
  case Pending, Paid

sealed trait Channel
case object Web extends Channel
case object Store extends Channel
`
    const { schema } = parseOk(text, 'scala')
    expect(fieldsOf(schema, 'Root')).toEqual([
      'invoice_id: string',
      'issued_at: datetime',
      'due_date: date',
      'total_cents: integer64',
      'notes: any',
      'coupon?: string | null',
      'lines: Line[]',
      'status: Status',
    ])
    expect(findModel(schema, 'Root')).toMatchObject({ kind: 'record', namespace: 'shop' })
    expect(findEnum(schema, 'Status')?.values.map((value) => value.name)).toEqual(['Pending', 'Paid'])
    expect(findEnum(schema, 'Channel')?.values.map((value) => value.name)).toEqual(['Web', 'Store'])
    expect(detectFormat(text)).toBe('scala')
  })

  it('reads Smithy structures, lists, maps and enums', () => {
    const text = `$version: "2"

namespace example.api

/// An invoice
structure Root {
    @required
    @jsonName("invoice_id")
    invoiceId: String

    @required
    @timestampFormat("date-time")
    issuedAt: Timestamp

    notes: Document

    @required
    lines: LineList

    scores: ScoreMap

    status: Status = "PENDING"
}

structure Line {
    @required
    qty: Integer
}

list LineList {
    member: Line
}

map ScoreMap {
    key: String
    value: Double
}

enum Status {
    PENDING = "pending"
    PAID = "paid"
}
`
    const { schema } = parseOk(text, 'smithy')
    expect(fieldsOf(schema, 'Root')).toEqual([
      'invoiceId: string',
      'issuedAt: datetime',
      'notes?: any',
      'lines: Line[]',
      'scores?: map<string, float64>',
      'status: Status',
    ])
    const root = findModel(schema, 'Root')!
    expect(root).toMatchObject({ namespace: 'example.api', description: 'An invoice' })
    expect(root.fields[0].serializedName).toBe('invoice_id')
    expect(root.fields[5].defaultValue).toBe('PENDING')
    expect(findEnum(schema, 'Status')?.values).toEqual([
      { name: 'PENDING', value: 'pending' },
      { name: 'PAID', value: 'paid' },
    ])
    expect(detectFormat(text)).toBe('smithy')
  })

  it('reads fields whose only value was null as nullable values of any shape', () => {
    const python = parseOk('@dataclass\nclass Root:\n    notes: None\n    name: str\n', 'python')
    expect(python.warnings).toEqual([])
    expect(fieldsOf(python.schema, 'Root')).toEqual(['notes: any | null', 'name: string'])
    const typescript = parseOk('export interface Root {\n  notes: null;\n}', 'typescript')
    expect(typescript.warnings).toEqual([])
    expect(fieldsOf(typescript.schema, 'Root')).toEqual(['notes: any | null'])
  })
})
