import type { InputFormatId } from '../core/parsers/types.ts'

/** Built-in examples, each showing one capability. The data is invented (personal_web_style UX_GUIDE §8):
 * only the name "Raúl Estévez" is real, emails use example.com. Titles and descriptions are in i18n. */

export type ExampleId = 'simple' | 'names' | 'nested' | 'transformations' | 'arrays'

export interface Example {
  id: ExampleId
  source: { format: InputFormatId; text: string; model: string }
  target: { format: InputFormatId; text: string; model: string }
  /** Output language that best shows the example */
  language: string
}

const SIMPLE_SOURCE = `export interface UserDto {
  userId: number
  firstName: string
  lastName: string
  emailAddress: string
  createdAt: string
  isActive: boolean
}
`

const SIMPLE_TARGET = `export interface User {
  id: number
  firstName: string
  lastName: string
  email: string
  createdAt: Date
  active: boolean
}
`

const NAMES_SOURCE = `{
  "customer_id": 1042,
  "given_name": "Raúl",
  "surname": "Estévez",
  "mail": "raul@example.com",
  "dob": "1990-04-02",
  "tel": "+34 600 000 000",
  "qty_orders": 12,
  "creation_date": "2026-01-15T10:30:00Z"
}
`

const NAMES_TARGET = `data class Customer(
    val customerId: Long,
    val firstName: String,
    val lastName: String,
    val email: String,
    val birthDate: LocalDate,
    val phone: String?,
    val orderQuantity: Int,
    val createdAt: Instant,
)
`

const NESTED_SOURCE = `public class OrderApi {
    private Long id;
    private CustomerApi customer;
    private AddressApi shipping;
    private String status;

    public static class CustomerApi {
        private Long id;
        private String name;
        private String email;
    }

    public static class AddressApi {
        private String street;
        private String city;
        private String zipCode;
        private String country;
    }
}
`

const NESTED_TARGET = `public class Order
{
    public long Id { get; set; }
    public long CustomerId { get; set; }
    public string CustomerName { get; set; } = "";
    public Address ShippingAddress { get; set; } = new();
    public string Status { get; set; } = "";
}

public class Address
{
    public string Street { get; set; } = "";
    public string City { get; set; } = "";
    public string PostalCode { get; set; } = "";
    public string Country { get; set; } = "";
}
`

const TRANSFORMATIONS_SOURCE = `export interface ProductResponse {
  sku: string
  first_name: string
  last_name: string
  price_cents: number
  status: ProductStatus
  created: number
  stock: string
  discount: number | null
}

export enum ProductStatus {
  Active = 'ACTIVE',
  Discontinued = 'DISCONTINUED',
  Draft = 'DRAFT',
}
`

const TRANSFORMATIONS_TARGET = `from datetime import datetime
from decimal import Decimal
from enum import Enum

from pydantic import BaseModel


class ProductState(str, Enum):
    ACTIVE = "active"
    DISCONTINUED = "discontinued"
    HIDDEN = "hidden"


class ProductModel(BaseModel):
    sku: str
    supplier_full_name: str
    price: Decimal
    status: ProductState
    active: bool
    created_at: datetime
    stock: int
    discount: float
`

const ARRAYS_SOURCE = `{
  "orderId": "A-1001",
  "placedAt": "2026-03-02T09:15:00Z",
  "items": [
    { "productId": 7, "title": "Notebook", "quantity": 2, "unitPrice": 3.5 },
    { "productId": 9, "title": "Pencil", "quantity": 10, "unitPrice": 0.4 }
  ],
  "tags": ["school", "paper"],
  "coupon": null
}
`

const ARRAYS_TARGET = `public record Order(String id, OffsetDateTime placedAt, List<OrderLine> lines, Set<String> tags, String coupon) {}

public record OrderLine(long productId, String name, int quantity, BigDecimal price) {}
`

export const EXAMPLES: readonly Example[] = [
  {
    id: 'simple',
    source: { format: 'typescript', text: SIMPLE_SOURCE, model: 'UserDto' },
    target: { format: 'typescript', text: SIMPLE_TARGET, model: 'User' },
    language: 'typescript',
  },
  {
    id: 'names',
    source: { format: 'json', text: NAMES_SOURCE, model: 'CustomerResponse' },
    target: { format: 'kotlin', text: NAMES_TARGET, model: 'Customer' },
    language: 'kotlin',
  },
  {
    id: 'nested',
    source: { format: 'java', text: NESTED_SOURCE, model: 'OrderApi' },
    target: { format: 'csharp', text: NESTED_TARGET, model: 'Order' },
    language: 'csharp',
  },
  {
    id: 'transformations',
    source: { format: 'typescript', text: TRANSFORMATIONS_SOURCE, model: 'ProductResponse' },
    target: { format: 'python', text: TRANSFORMATIONS_TARGET, model: 'ProductModel' },
    language: 'python',
  },
  {
    id: 'arrays',
    source: { format: 'json', text: ARRAYS_SOURCE, model: 'OrderApi' },
    target: { format: 'java', text: ARRAYS_TARGET, model: 'Order' },
    language: 'java',
  },
]

export function findExample(id: string): Example | undefined {
  return EXAMPLES.find((example) => example.id === id)
}
