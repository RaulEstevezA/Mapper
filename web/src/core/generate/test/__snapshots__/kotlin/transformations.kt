import java.math.BigDecimal
import java.math.MathContext
import java.time.Instant

fun ProductResponse.toProductModel(): ProductModel = ProductModel(
    sku = sku,
    supplierFullName = "${firstName} ${lastName}",
    price = priceCents.toBigDecimal().divide(BigDecimal.valueOf(100L), MathContext.DECIMAL128),
    status = toProductState(status),
    active = status == ProductStatus.Active,
    createdAt = Instant.ofEpochSecond(created.toLong()),
    stock = stock.toLong(),
    discount = requireNotNull(discount) { "A required value is missing in the source" },
)

private fun toProductState(value: ProductStatus): ProductState = when (value) {
    ProductStatus.Active -> ProductState.ACTIVE
    ProductStatus.Discontinued -> ProductState.DISCONTINUED
    else -> throw IllegalArgumentException("Unexpected ProductStatus: $value")
}
