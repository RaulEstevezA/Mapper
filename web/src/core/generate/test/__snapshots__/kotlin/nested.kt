fun OrderApi.toOrder(): Order {
    val target = Order()
    target.id = requireNotNull(id) { "A required value is missing in the source" }
    target.customerId = requireNotNull(customer.id) { "A required value is missing in the source" }
    target.customerName = customer.name
    target.shippingAddress = shipping.toAddress()
    target.status = status
    return target
}

fun AddressApi.toAddress(): Address {
    val target = Address()
    target.street = street
    target.city = city
    target.postalCode = zipCode
    target.country = country
    return target
}
