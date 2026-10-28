from datetime import date, datetime
from typing import Any

from models import Customer


def map_customer_response_to_customer(source: dict[str, Any]) -> Customer:
    return Customer(
        customer_id=source["customer_id"],
        first_name=source["given_name"],
        last_name=source["surname"],
        email=source["mail"],
        birth_date=date.fromisoformat(source["dob"]),
        phone=source["tel"],
        order_quantity=source["qty_orders"],
        created_at=datetime.fromisoformat(source["creation_date"]),
    )
