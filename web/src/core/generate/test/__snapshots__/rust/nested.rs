use crate::models::{Address, AddressApi, Order, OrderApi};

impl From<&OrderApi> for Order {
    fn from(source: &OrderApi) -> Self {
        Self {
            id: source.id.expect("a required value is missing in the source"),
            customer_id: source.customer.id.expect("a required value is missing in the source"),
            customer_name: Some(source.customer.name.clone()),
            shipping_address: Some(Address::from(&source.shipping)),
            status: Some(source.status.clone()),
        }
    }
}

impl From<&AddressApi> for Address {
    fn from(source: &AddressApi) -> Self {
        Self {
            street: Some(source.street.clone()),
            city: Some(source.city.clone()),
            postal_code: Some(source.zip_code.clone()),
            country: Some(source.country.clone()),
        }
    }
}
