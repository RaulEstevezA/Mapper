from dataclasses import dataclass
from datetime import date, datetime


@dataclass
class Customer:
    customer_id: int
    given_name: str
    surname: str
    mail: str
    dob: date
    tel: str
    qty_orders: int
    creation_date: datetime
