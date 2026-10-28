fun CustomerResponse.toCustomer(): Customer = Customer(
    customerId = customerId,
    firstName = givenName,
    lastName = surname,
    email = mail,
    birthDate = dob,
    phone = tel,
    orderQuantity = qtyOrders.toInt(),
    createdAt = creationDate,
)
