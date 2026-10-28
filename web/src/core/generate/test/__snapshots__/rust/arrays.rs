use rust_decimal::Decimal;
use crate::models::{Item, Order, OrderApi, OrderLine};

impl From<&OrderApi> for Order {
    fn from(source: &OrderApi) -> Self {
        Self {
            id: source.order_id.clone(),
            placed_at: source.placed_at.clone(),
            lines: source.items.iter().map(OrderLine::from).collect(),
            tags: source.tags.iter().cloned().collect(),
            coupon: source.coupon.as_ref().map(|value| value.to_string()).expect("a required value is missing in the source"),
        }
    }
}

impl From<&Item> for OrderLine {
    fn from(source: &Item) -> Self {
        Self {
            product_id: source.product_id,
            name: source.title.clone(),
            quantity: source.quantity as i32,
            price: Decimal::try_from(source.unit_price).expect("number out of range"),
        }
    }
}
