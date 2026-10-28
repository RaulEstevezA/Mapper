import { describe, expect, it } from 'vitest'
import { findEnum, findModel } from '../../model/schema.ts'
import { detectFormat, parseInput } from '../registry.ts'
import { fieldsOf, parseOk } from './helpers.ts'

describe('Python', () => {
  it('reads dataclasses with optional and generic types', () => {
    const { schema } = parseOk(
      `from dataclasses import dataclass, field
from typing import Optional, List

@dataclass
class OrderItem:
    sku: str
    quantity: int = 1

@dataclass(frozen=True)
class Order:
    """An order placed in the shop."""
    id: int
    customer_name: Optional[str]
    items: List[OrderItem] = field(default_factory=list)
    notes: str | None = None
    total: "Decimal" = 0
    tags: dict[str, int] = field(default_factory=dict)
    MAX: ClassVar[int] = 10
`,
      'python',
    )
    expect(fieldsOf(schema, 'Order')).toEqual([
      'id: integer',
      'customer_name: string | null',
      'items?: OrderItem[]',
      'notes?: string | null',
      'total?: decimal',
      'tags?: map<string, integer>',
    ])
    expect(findModel(schema, 'Order')).toMatchObject({
      framework: 'dataclass',
      description: 'An order placed in the shop.',
      construction: 'named',
    })
    expect(fieldsOf(schema, 'OrderItem')).toEqual(['sku: string', 'quantity?: integer'])
    expect(findModel(schema, 'OrderItem')!.fields[1].defaultValue).toBe(1)
  })

  it('reads Pydantic models with aliases, literals and enums', () => {
    const { schema } = parseOk(
      `from enum import Enum
from pydantic import BaseModel, Field, EmailStr

class Status(str, Enum):
    ACTIVE = "active"
    BLOCKED = "blocked"

class User(BaseModel):
    user_id: int = Field(alias="userId")
    email: EmailStr
    status: Status = Status.ACTIVE
    kind: Literal["admin", "member"]
    created_at: datetime = Field(default_factory=datetime.now, description="Creation time")
`,
      'python',
    )
    expect(findEnum(schema, 'Status')?.values).toEqual([
      { name: 'ACTIVE', value: 'active' },
      { name: 'BLOCKED', value: 'blocked' },
    ])
    expect(fieldsOf(schema, 'User')).toEqual([
      'user_id: integer',
      'email: string',
      'status?: Status',
      'kind: Kind',
      'created_at?: datetime',
    ])
    const user = findModel(schema, 'User')!
    expect(user.framework).toBe('pydantic')
    expect(user.fields[0].serializedName).toBe('userId')
    expect(user.fields[4].description).toBe('Creation time')
    expect(findEnum(schema, 'Kind')?.values.map((value) => value.name)).toEqual(['admin', 'member'])
  })

  it('reads plain classes from __init__', () => {
    const { schema } = parseOk(
      `class Customer:
    def __init__(self, name: str, age: int = 0, email=None):
        self.name = name
        self.age = age
        self.active = True
        self._cache = {}

    def greet(self):
        return self.name
`,
      'python',
    )
    expect(fieldsOf(schema, 'Customer')).toEqual(['name: string', 'age?: integer', 'active: boolean'])
  })

  it('reads Django models, adding the implicit id', () => {
    const { schema } = parseOk(
      `from django.db import models

class Product(models.Model):
    name = models.CharField(max_length=100)
    description = models.TextField(blank=True, null=True)
    price = models.DecimalField(max_digits=8, decimal_places=2)
    category = models.ForeignKey('Category', on_delete=models.CASCADE)
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']

class Category(models.Model):
    title = models.CharField(max_length=50, db_column='category_title')
`,
      'python',
    )
    expect(fieldsOf(schema, 'Product')).toEqual([
      'id: integer',
      'name: string',
      'description?: string | null',
      'price: decimal',
      'category: Category',
      'created: datetime',
    ])
    const product = findModel(schema, 'Product')!
    expect(product.kind).toBe('entity')
    expect(product.fields[0].generated).toBe(true)
    expect(product.fields[5].generated).toBe(true)
    expect(findModel(schema, 'Category')!.fields[1].serializedName).toBe('category_title')
  })

  it('reads SQLAlchemy models, classic and typed', () => {
    const { schema } = parseOk(
      `class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String(120), nullable=False)
    nickname = Column(String)

class Post(Base):
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[Optional[str]]
`,
      'python',
    )
    expect(fieldsOf(schema, 'User')).toEqual(['id: integer', 'email: string', 'nickname: string | null'])
    expect(findModel(schema, 'User')!.fields[0].generated).toBe(true)
    expect(fieldsOf(schema, 'Post')).toEqual(['id: integer', 'title: string', 'body: string | null'])
    expect(schema.origin?.framework).toBe('sqlalchemy')
  })

  it('reads TypedDicts', () => {
    const { schema } = parseOk('class Movie(TypedDict, total=False):\n    title: str\n    year: int\n', 'python')
    expect(fieldsOf(schema, 'Movie')).toEqual(['title?: string', 'year?: integer'])
  })

  it('reports errors and is detected', () => {
    expect(parseInput('class A:\n    b: str = """x', 'python')).toMatchObject({ ok: false, error: { code: 'unterminatedString', line: 2 } })
    expect(parseInput('x = 1\n', 'python')).toMatchObject({ ok: false, error: { code: 'noModels' } })
    expect(detectFormat('class User:\n    name: str\n')).toBe('python')
  })
})
