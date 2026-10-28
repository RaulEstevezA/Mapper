import Foundation

extension OrderApi {
    func toOrder() -> Order {
        Order(
            id: id!,
            customerId: customer.id!,
            customerName: customer.name,
            shippingAddress: shipping.toAddress(),
            status: status
        )
    }
}

extension AddressApi {
    func toAddress() -> Address {
        Address(
            street: street,
            city: city,
            postalCode: zipCode,
            country: country
        )
    }
}
