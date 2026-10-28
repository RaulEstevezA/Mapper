use crate::models::{Customer, CustomerResponse};

impl From<&CustomerResponse> for Customer {
    fn from(source: &CustomerResponse) -> Self {
        Self {
            customer_id: source.customer_id,
            first_name: source.given_name.clone(),
            last_name: source.surname.clone(),
            email: source.mail.clone(),
            birth_date: source.dob.clone(),
            phone: Some(source.tel.clone()),
            order_quantity: source.qty_orders as i32,
            created_at: source.creation_date.clone(),
        }
    }
}
