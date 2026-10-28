import java.time.LocalDate;
import java.time.OffsetDateTime;

public record Customer(
        long customerId,
        String givenName,
        String surname,
        String mail,
        LocalDate dob,
        String tel,
        long qtyOrders,
        OffsetDateTime creationDate
) {
}
