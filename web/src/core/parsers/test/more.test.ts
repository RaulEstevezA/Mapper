import { describe, expect, it } from 'vitest'
import { findEnum, findModel } from '../../model/schema.ts'
import { detectFormat } from '../registry.ts'
import { fieldsOf, parseOk } from './helpers.ts'

describe('Dart', () => {
  it('reads Flutter model classes with named constructors and JsonKey', () => {
    const { schema } = parseOk(
      `import 'package:json_annotation/json_annotation.dart';

/// A product of the catalog
@JsonSerializable()
class Product {
  final int id;
  @JsonKey(name: 'product_name')
  final String name;
  final double? price;
  final List<String> tags;
  final DateTime createdAt;
  bool featured = false;
  static const version = 1;
  final String _cache = '';

  Product({required this.id, required this.name, this.price, this.tags = const [], required this.createdAt});

  factory Product.fromJson(Map<String, dynamic> json) => _$ProductFromJson(json);
  String get label => name;
  Map<String, dynamic> toJson() => _$ProductToJson(this);
}

enum Status { active, blocked }

enum Level {
  @JsonValue('L') low('low'),
  high('high');

  final String code;
  const Level(this.code);
}`,
      'dart',
    )
    expect(fieldsOf(schema, 'Product')).toEqual([
      'id: integer64',
      'name: string',
      'price?: float64 | null',
      'tags?: string[]',
      'createdAt: datetime',
      'featured: boolean',
    ])
    const product = findModel(schema, 'Product')!
    expect(product).toMatchObject({ construction: 'named', framework: 'json_serializable', description: 'A product of the catalog' })
    expect(product.fields[1].serializedName).toBe('product_name')
    expect(findEnum(schema, 'Status')!.values).toEqual([{ name: 'active' }, { name: 'blocked' }])
    expect(findEnum(schema, 'Level')!.values).toEqual([
      { name: 'low', value: 'L' },
      { name: 'high', value: 'high' },
    ])
  })

  it('reads freezed factories', () => {
    const { schema } = parseOk(
      `@freezed
class User with _$User {
  const factory User({
    required String id,
    @JsonKey(name: 'full_name') required String fullName,
    @Default(0) int age,
    String? email,
  }) = _User;
}`,
      'dart',
    )
    expect(fieldsOf(schema, 'User')).toEqual(['id: string', 'fullName: string', 'age?: integer64', 'email?: string | null'])
    expect(findModel(schema, 'User')!.fields[1].serializedName).toBe('full_name')
    expect(findModel(schema, 'User')!.fields[2].defaultValue).toBe(0)
  })
})

describe('Swift', () => {
  it('reads Codable structs with CodingKeys and enums', () => {
    const { schema } = parseOk(
      `import Foundation

/// A user returned by the API
struct User: Codable, Identifiable {
    let id: Int
    var name: String
    var email: String?
    let tags: [String]
    let scores: [String: Double]
    var address: Address? = nil
    let createdAt: Date
    let role: Role
    var displayName: String { name.uppercased() }
    static let sample = User()

    enum CodingKeys: String, CodingKey {
        case id, name = "full_name", email, tags, scores, address, createdAt = "created_at", role
    }
}

struct Address: Codable { let city: String }

enum Role: String, Codable {
    case admin = "ADMIN"
    case member
}`,
      'swift',
    )
    expect(fieldsOf(schema, 'User')).toEqual([
      'id: integer64',
      'name: string',
      'email: string | null',
      'tags: string[]',
      'scores: map<string, float64>',
      'address?: Address | null',
      'createdAt: datetime',
      'role: Role',
    ])
    const user = findModel(schema, 'User')!
    expect(user).toMatchObject({ kind: 'struct', framework: 'codable', description: 'A user returned by the API' })
    expect(user.fields[1].serializedName).toBe('full_name')
    expect(findEnum(schema, 'Role')!.values).toEqual([{ name: 'admin', value: 'ADMIN' }, { name: 'member' }])
  })
})

describe('Go', () => {
  it('reads structs with tags, pointers, embedding and const enums', () => {
    const { schema } = parseOk(
      `package models

import "time"

// Order is a purchase.
type Order struct {
	Base
	ID        int64     \`json:"id" gorm:"primaryKey;autoIncrement"\`
	Customer  *Customer \`json:"customer,omitempty"\`
	Lines     []Line    \`json:"lines"\`
	Total     float64   \`json:"total"\`
	Status    Status    \`json:"status"\`
	Note, Ref string
	CreatedAt time.Time \`json:"created_at"\`
	Meta      map[string]any
	Raw       []byte
	secret    string
	Ignored   string \`json:"-"\`
}

type Base struct{ Version int }
type Customer struct{ Name string }
type Line struct{ SKU string; Qty int }

type Status string

const (
	StatusPending Status = "pending"
	StatusPaid    Status = "paid"
)

type Level int

const (
	Low Level = iota
	High
)`,
      'go',
    )
    expect(fieldsOf(schema, 'Order')).toEqual([
      'ID: integer64',
      'Customer?: Customer | null',
      'Lines: Line[]',
      'Total: float64',
      'Status: Status',
      'Note: string',
      'Ref: string',
      'CreatedAt: datetime',
      'Meta: map<string, any>',
      'Raw: binary',
    ])
    const order = findModel(schema, 'Order')!
    expect(order).toMatchObject({ extends: ['Base'], namespace: 'models', description: 'Order is a purchase.' })
    expect(order.fields[0]).toMatchObject({ serializedName: 'id', generated: true })
    expect(order.fields[7].serializedName).toBe('created_at')
    expect(fieldsOf(schema, 'Line')).toEqual(['SKU: string', 'Qty: integer64'])
    expect(findEnum(schema, 'Status')!.values).toEqual([
      { name: 'StatusPending', value: 'pending' },
      { name: 'StatusPaid', value: 'paid' },
    ])
    expect(findEnum(schema, 'Level')!.values).toEqual([
      { name: 'Low', value: 0 },
      { name: 'High', value: 1 },
    ])
  })
})

describe('Rust', () => {
  it('reads serde structs and enums', () => {
    const { schema } = parseOk(
      `use serde::{Deserialize, Serialize};

/// An invoice
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invoice {
    pub id: u64,
    pub customer_name: String,
    #[serde(rename = "total_amount")]
    pub total: Decimal,
    pub notes: Option<String>,
    pub lines: Vec<InvoiceLine>,
    pub tags: HashMap<String, i32>,
    pub issued_at: chrono::DateTime<Utc>,
    pub pdf: Vec<u8>,
    #[serde(default)]
    pub paid: bool,
    #[serde(skip)]
    cache: Box<String>,
}

pub struct InvoiceLine { pub sku: String, pub quantity: u32 }

#[derive(Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum State { Draft, Sent, Paid { at: String } }`,
      'rust',
    )
    expect(fieldsOf(schema, 'Invoice')).toEqual([
      'id: integer64',
      'customer_name: string',
      'total: decimal',
      'notes?: string | null',
      'lines: InvoiceLine[]',
      'tags: map<string, integer32>',
      'issued_at: datetime',
      'pdf: binary',
      'paid?: boolean',
    ])
    const invoice = findModel(schema, 'Invoice')!
    expect(invoice).toMatchObject({ framework: 'serde', description: 'An invoice' })
    expect(invoice.fields[1].serializedName).toBe('customerName')
    expect(invoice.fields[2].serializedName).toBe('total_amount')
    expect(findEnum(schema, 'State')!.values).toEqual([
      { name: 'Draft', value: 'DRAFT' },
      { name: 'Sent', value: 'SENT' },
      { name: 'Paid', value: 'PAID' },
    ])
  })
})

describe('PHP', () => {
  it('reads typed properties, promoted constructors, docblocks and enums', () => {
    const { schema } = parseOk(
      `<?php
namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Order
{
    #[ORM\\Id]
    #[ORM\\GeneratedValue]
    #[ORM\\Column]
    private ?int $id = null;

    #[ORM\\Column(name: 'customer_name', length: 100)]
    private string $customerName;

    /** @var OrderLine[] */
    private array $lines = [];

    private ?\\DateTimeImmutable $createdAt;
    private Status $status;
    public static int $count = 0;

    public function getId(): ?int { return $this->id; }
}

final class OrderLine
{
    public function __construct(
        public readonly string $sku,
        public int $quantity = 1,
        string $notPromoted = '',
    ) {}
}

enum Status: string
{
    case Pending = 'pending';
    case Paid = 'paid';
}`,
      'php',
    )
    expect(fieldsOf(schema, 'Order')).toEqual([
      'id?: integer64 | null',
      'customerName: string',
      'lines?: OrderLine[]',
      'createdAt: datetime | null',
      'status: Status',
    ])
    const order = findModel(schema, 'Order')!
    expect(order).toMatchObject({ kind: 'entity', framework: 'doctrine', namespace: 'App\\Entity', metadata: { accessors: 'getters' } })
    expect(order.fields[0].generated).toBe(true)
    expect(order.fields[1].serializedName).toBe('customer_name')
    expect(fieldsOf(schema, 'OrderLine')).toEqual(['sku: string', 'quantity?: integer64'])
    expect(findModel(schema, 'OrderLine')!.construction).toBe('named')
    expect(findEnum(schema, 'Status')!.values).toEqual([
      { name: 'Pending', value: 'pending' },
      { name: 'Paid', value: 'paid' },
    ])
  })
})

describe('detection of code', () => {
  it('tells languages apart', () => {
    expect(detectFormat("import 'package:flutter/material.dart';\nclass A { final String b; A(this.b); }")).toBe('dart')
    expect(detectFormat('struct User: Codable {\n  let id: Int\n}')).toBe('swift')
    expect(detectFormat('type User struct {\n\tName string\n}')).toBe('go')
    expect(detectFormat('#[derive(Debug)]\npub struct A { pub b: String }')).toBe('rust')
    expect(detectFormat('<?php class A { public string $b; }')).toBe('php')
    expect(detectFormat('data class A(val b: String)')).toBe('kotlin')
    expect(detectFormat('public class A { public string B { get; set; } }')).toBe('csharp')
  })
})
