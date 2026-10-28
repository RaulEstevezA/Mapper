import 'models.dart';

extension OrderApiMapping on OrderApi {
  Order toOrder() => Order(
        id: id!,
        customerId: customer.id!,
        customerName: customer.name,
        shippingAddress: shipping.toAddress(),
        status: status,
      );
}

extension AddressApiMapping on AddressApi {
  Address toAddress() => Address(
        street: street,
        city: city,
        postalCode: zipCode,
        country: country,
      );
}
