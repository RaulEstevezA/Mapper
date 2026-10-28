import java.time.Instant

data class Item(
    val productId: Long,
    val title: String,
    val quantity: Long,
    val unitPrice: Double,
)

data class Order(
    val orderId: String,
    val placedAt: Instant,
    val items: List<Item>,
    val tags: List<String>,
    val coupon: Any? = null,
)
