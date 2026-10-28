import java.math.BigDecimal;
import java.math.MathContext;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Objects;

public final class ProductResponseMapper {

    private ProductResponseMapper() {
    }

    public static ProductModel toProductModel(ProductResponse source) {
        if (source == null) {
            return null;
        }
        ProductModel target = new ProductModel();
        target.setSku(source.getSku());
        target.setSupplierFullName(source.getFirstName() + " " + source.getLastName());
        target.setPrice(BigDecimal.valueOf(source.getPriceCents()).divide(BigDecimal.valueOf(100), MathContext.DECIMAL128));
        target.setStatus(toProductState(source.getStatus()));
        target.setActive(source.getStatus() == ProductStatus.Active);
        target.setCreatedAt(OffsetDateTime.ofInstant(Instant.ofEpochSecond((long) source.getCreated()), ZoneOffset.UTC));
        target.setStock(Long.parseLong(source.getStock()));
        // "discount" is required: fails if the source is missing
        target.setDiscount(Objects.requireNonNull(source.getDiscount()));
        return target;
    }

    private static ProductState toProductState(ProductStatus value) {
        return switch (value) {
            case Active -> ProductState.ACTIVE;
            case Discontinued -> ProductState.DISCONTINUED;
            default -> throw new IllegalArgumentException("Unexpected ProductStatus: " + value);
        };
    }
}
