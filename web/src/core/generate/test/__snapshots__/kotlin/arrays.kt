import java.math.BigDecimal

fun OrderApi.toOrder(): Order = Order(
    id = orderId,
    placedAt = placedAt,
    lines = items.map { it.toOrderLine() },
    tags = tags.toSet(),
    coupon = requireNotNull(coupon?.let { value -> value.toString() }) { "A required value is missing in the source" },
)

fun Item.toOrderLine(): OrderLine = OrderLine(
    productId = productId,
    name = title,
    quantity = quantity.toInt(),
    price = unitPrice.toBigDecimal(),
)
