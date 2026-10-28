
from models import Address, AddressApi, Order, OrderApi


def map_order_api_to_order(source: OrderApi) -> Order:
    return Order(
        # TODO: the source may be missing, but "Id" is required
        id=source.id,
        # TODO: the source may be missing, but "CustomerId" is required
        customer_id=source.customer.id,
        customer_name=source.customer.name,
        shipping_address=map_address_api_to_address(source.shipping),
        status=source.status,
    )


def map_address_api_to_address(source: AddressApi) -> Address:
    return Address(
        street=source.street,
        city=source.city,
        postal_code=source.zip_code,
        country=source.country,
    )
