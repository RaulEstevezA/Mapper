from dataclasses import dataclass


@dataclass
class Customer:
    name: str
    email: str
    id: int | None = None


@dataclass
class Address:
    street: str
    city: str
    zip_code: str
    country: str


@dataclass
class Order:
    customer: Customer
    shipping: Address
    status: str
    id: int | None = None
