import Foundation

extension OrderApi {
    func toOrder() -> Order {
        Order(
            id: orderId,
            placedAt: placedAt,
            lines: items.map { $0.toOrderLine() },
            tags: Set(tags),
            coupon: (coupon.map { value in String(describing: value) })!
        )
    }
}

extension Item {
    func toOrderLine() -> OrderLine {
        OrderLine(
            productId: productId,
            name: title,
            quantity: Int32(quantity),
            price: Decimal(unitPrice)
        )
    }
}
