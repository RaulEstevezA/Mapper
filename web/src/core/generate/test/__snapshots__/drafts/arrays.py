from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass
class Item:
    product_id: int
    title: str
    quantity: int
    unit_price: float


@dataclass
class Order:
    order_id: str
    placed_at: datetime
    items: list[Item]
    tags: list[str]
    coupon: Any | None = None
