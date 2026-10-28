import java.time.Instant
import java.time.LocalDate

data class Customer(
    val customerId: Long,
    val givenName: String,
    val surname: String,
    val mail: String,
    val dob: LocalDate,
    val tel: String,
    val qtyOrders: Long,
    val creationDate: Instant,
)
