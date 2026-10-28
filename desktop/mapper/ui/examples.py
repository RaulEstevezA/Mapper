"""The examples of the presentation. The same as web/src/examples/index.ts: shared/test-cases/generators/example-*
checks that both versions map them alike."""

SIMPLE_SOURCE = """\
export interface UserDto {
  userId: number
  firstName: string
  lastName: string
  emailAddress: string
  createdAt: string
  isActive: boolean
}
"""

SIMPLE_TARGET = """\
export interface User {
  id: number
  firstName: string
  lastName: string
  email: string
  createdAt: Date
  active: boolean
}
"""

NAMES_SOURCE = """\
{
  "customer_id": 1042,
  "given_name": "Raúl",
  "surname": "Estévez",
  "mail": "raul@example.com",
  "dob": "1990-04-02",
  "tel": "+34 600 000 000",
  "qty_orders": 12,
  "creation_date": "2026-01-15T10:30:00Z"
}
"""

NAMES_TARGET = """\
data class Customer(
    val customerId: Long,
    val firstName: String,
    val lastName: String,
    val email: String,
    val birthDate: LocalDate,
    val phone: String?,
    val orderQuantity: Int,
    val createdAt: Instant,
)
"""

NESTED_SOURCE = """\
public class OrderApi {
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
"""

NESTED_TARGET = """\
public class Order
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
"""

TRANSFORMATIONS_SOURCE = """\
export interface ProductResponse {
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
"""

TRANSFORMATIONS_TARGET = """\
from datetime import datetime
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
"""

ARRAYS_SOURCE = """\
{
  "orderId": "A-1001",
  "placedAt": "2026-03-02T09:15:00Z",
  "items": [
    { "productId": 7, "title": "Notebook", "quantity": 2, "unitPrice": 3.5 },
    { "productId": 9, "title": "Pencil", "quantity": 10, "unitPrice": 0.4 }
  ],
  "tags": ["school", "paper"],
  "coupon": null
}
"""

ARRAYS_TARGET = """\
public record Order(String id, OffsetDateTime placedAt, List<OrderLine> lines, Set<String> tags, String coupon) {}

public record OrderLine(long productId, String name, int quantity, BigDecimal price) {}
"""

EXAMPLES = [
    {
        "id": "simple",
        "source": {"format": "typescript", "model": "UserDto", "text": SIMPLE_SOURCE},
        "target": {"format": "typescript", "model": "User", "text": SIMPLE_TARGET},
        "language": "typescript",
    },
    {
        "id": "names",
        "source": {"format": "json", "model": "CustomerResponse", "text": NAMES_SOURCE},
        "target": {"format": "kotlin", "model": "Customer", "text": NAMES_TARGET},
        "language": "kotlin",
    },
    {
        "id": "nested",
        "source": {"format": "java", "model": "OrderApi", "text": NESTED_SOURCE},
        "target": {"format": "csharp", "model": "Order", "text": NESTED_TARGET},
        "language": "csharp",
    },
    {
        "id": "transformations",
        "source": {"format": "typescript", "model": "ProductResponse", "text": TRANSFORMATIONS_SOURCE},
        "target": {"format": "python", "model": "ProductModel", "text": TRANSFORMATIONS_TARGET},
        "language": "python",
    },
    {
        "id": "arrays",
        "source": {"format": "json", "model": "OrderApi", "text": ARRAYS_SOURCE},
        "target": {"format": "java", "model": "Order", "text": ARRAYS_TARGET},
        "language": "java",
    },
]


def find_example(example_id: str) -> dict | None:
    return next((example for example in EXAMPLES if example["id"] == example_id), None)
