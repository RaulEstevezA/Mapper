import java.math.BigDecimal;
import java.util.HashSet;
import java.util.Objects;

public final class OrderApiMapper {

    private OrderApiMapper() {
    }

    public static Order toOrder(OrderApi source) {
        if (source == null) {
            return null;
        }
        return new Order(
                source.getOrderId(),
                source.getPlacedAt(),
                source.getItems().stream().map(OrderApiMapper::toOrderLine).toList(),
                new HashSet<>(source.getTags()),
                // "coupon" is required: fails if the source is missing
                Objects.requireNonNull(source.getCoupon() != null ? String.valueOf(source.getCoupon()) : null)
        );
    }

    public static OrderLine toOrderLine(Item source) {
        if (source == null) {
            return null;
        }
        return new OrderLine(
                (long) source.getProductId(),
                source.getTitle(),
                Math.toIntExact(source.getQuantity()),
                BigDecimal.valueOf(source.getUnitPrice())
        );
    }
}
