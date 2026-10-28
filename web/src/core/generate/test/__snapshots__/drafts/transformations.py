from dataclasses import dataclass
from enum import Enum


class ProductStatus(str, Enum):
    ACTIVE = "ACTIVE"
    DISCONTINUED = "DISCONTINUED"
    DRAFT = "DRAFT"


@dataclass
class Product:
    sku: str
    first_name: str
    last_name: str
    price_cents: float
    status: ProductStatus
    created: float
    stock: str
    discount: float | None = None
