data class Customer(
    val id: Long? = null,
    val name: String,
    val email: String,
)

data class Address(
    val street: String,
    val city: String,
    val zipCode: String,
    val country: String,
)

data class Order(
    val id: Long? = null,
    val customer: Customer,
    val shipping: Address,
    val status: String,
)
