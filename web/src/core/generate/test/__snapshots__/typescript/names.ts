import type { CustomerResponse } from './source-models'
import type { Customer } from './target-models'

export function mapCustomerResponseToCustomer(source: CustomerResponse): Customer {
  return {
    customerId: source.customer_id,
    firstName: source.given_name,
    lastName: source.surname,
    email: source.mail,
    birthDate: new Date(source.dob),
    phone: source.tel,
    orderQuantity: source.qty_orders,
    createdAt: new Date(source.creation_date),
  }
}
