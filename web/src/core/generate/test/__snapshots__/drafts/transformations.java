public enum ProductStatus {
    ACTIVE,
    DISCONTINUED,
    DRAFT
}

public record Product(
        String sku,
        String firstName,
        String lastName,
        double priceCents,
        ProductStatus status,
        double created,
        String stock,
        Double discount
) {
}
