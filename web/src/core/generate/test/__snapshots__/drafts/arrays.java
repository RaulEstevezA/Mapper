import java.time.OffsetDateTime;
import java.util.List;

public record Item(
        long productId,
        String title,
        long quantity,
        double unitPrice
) {
}

public record Order(
        String orderId,
        OffsetDateTime placedAt,
        List<Item> items,
        List<String> tags,
        Object coupon
) {
}
