import 'models.dart';

extension CustomerResponseMapping on CustomerResponse {
  Customer toCustomer() => Customer(
        customerId: customerId,
        firstName: givenName,
        lastName: surname,
        email: mail,
        birthDate: dob,
        phone: tel,
        orderQuantity: qtyOrders,
        createdAt: creationDate,
      );
}
