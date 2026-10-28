enum class ProductStatus { ACTIVE, DISCONTINUED, DRAFT }

data class Product(
    val sku: String,
    val firstName: String,
    val lastName: String,
    val priceCents: Double,
    val status: ProductStatus,
    val created: Double,
    val stock: String,
    val discount: Double? = null,
)
