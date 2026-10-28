from datetime import datetime, timezone
from decimal import Decimal

from models import ProductModel, ProductResponse, ProductState, ProductStatus


def map_product_response_to_product_model(source: ProductResponse) -> ProductModel:
    return ProductModel(
        sku=source.sku,
        supplier_full_name=f"{source.first_name} {source.last_name}",
        price=Decimal(str(source.price_cents)) / 100,
        status=_map_product_status_to_product_state(source.status),
        active=source.status == ProductStatus.Active,
        created_at=datetime.fromtimestamp(source.created, tz=timezone.utc),
        stock=int(source.stock),
        # TODO: the source may be missing, but "discount" is required
        discount=source.discount,
    )


_PRODUCT_STATUS_TO_PRODUCT_STATE = {
    ProductStatus.Active: ProductState.ACTIVE,
    ProductStatus.Discontinued: ProductState.DISCONTINUED,
}


def _map_product_status_to_product_state(value: ProductStatus) -> ProductState:
    return _PRODUCT_STATUS_TO_PRODUCT_STATE[value]
