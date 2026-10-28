import type { AddressApi, OrderApi } from './source-models'
import { Address, Order } from './target-models'

export function mapOrderApiToOrder(source: OrderApi): Order {
  return Object.assign(new Order(), {
    // TODO: the source may be missing, but "Id" is required
    Id: source.id!,
    // TODO: the source may be missing, but "CustomerId" is required
    CustomerId: source.customer.id!,
    CustomerName: source.customer.name,
    ShippingAddress: mapAddressApiToAddress(source.shipping),
    Status: source.status,
  })
}

export function mapAddressApiToAddress(source: AddressApi): Address {
  return Object.assign(new Address(), {
    Street: source.street,
    City: source.city,
    PostalCode: source.zipCode,
    Country: source.country,
  })
}
