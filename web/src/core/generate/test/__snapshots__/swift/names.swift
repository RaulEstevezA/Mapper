import Foundation

extension CustomerResponse {
    func toCustomer() -> Customer {
        Customer(
            customerId: customerId,
            firstName: givenName,
            lastName: surname,
            email: mail,
            birthDate: dob,
            phone: tel,
            orderQuantity: Int32(qtyOrders),
            createdAt: creationDate
        )
    }
}
