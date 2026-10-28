import 'models.dart';

extension OrderApiMapping on OrderApi {
  Order toOrder() => Order(
        orderId,
        placedAt,
        items.map((item) => item.toOrderLine()).toList(),
        Set.of(tags),
        (coupon == null ? null : coupon!.toString())!,
      );
}

extension ItemMapping on Item {
  OrderLine toOrderLine() => OrderLine(
        productId,
        title,
        quantity,
        unitPrice,
      );
}
