from datetime import datetime
from decimal import Decimal
from typing import Any

from models import Order, OrderLine


def map_order_api_to_order(source: dict[str, Any]) -> Order:
    return Order(
        id=source["orderId"],
        placed_at=datetime.fromisoformat(source["placedAt"]),
        lines=[map_item_to_order_line(item) for item in source["items"]],
        tags=list(source["tags"]),
        # TODO: the source may be missing, but "coupon" is required
        coupon=str(source.get("coupon")) if source.get("coupon") is not None else None,
    )


def map_item_to_order_line(source: dict[str, Any]) -> OrderLine:
    return OrderLine(
        product_id=source["productId"],
        name=source["title"],
        quantity=source["quantity"],
        price=Decimal(str(source["unitPrice"])),
    )
