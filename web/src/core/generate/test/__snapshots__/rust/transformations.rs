use chrono::DateTime;
use rust_decimal::Decimal;
use crate::models::{ProductModel, ProductResponse, ProductState, ProductStatus};

impl From<&ProductResponse> for ProductModel {
    fn from(source: &ProductResponse) -> Self {
        Self {
            sku: source.sku.clone(),
            supplier_full_name: format!("{} {}", source.first_name, source.last_name),
            price: Decimal::try_from(source.price_cents).expect("number out of range") / Decimal::from(100),
            status: to_product_state(&source.status),
            active: matches!(source.status, ProductStatus::Active),
            created_at: DateTime::from_timestamp(source.created as i64, 0).expect("timestamp out of range"),
            stock: source.stock.parse::<i64>().expect("number is not valid"),
            discount: source.discount.expect("a required value is missing in the source"),
        }
    }
}

fn to_product_state(value: &ProductStatus) -> ProductState {
    match value {
        ProductStatus::Active => ProductState::ACTIVE,
        ProductStatus::Discontinued => ProductState::DISCONTINUED,
        _ => panic!("unexpected ProductStatus: {:?}", value),
    }
}
