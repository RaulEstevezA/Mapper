public record Customer(
        Long id,
        String name,
        String email
) {
}

public record Address(
        String street,
        String city,
        String zipCode,
        String country
) {
}

public record Order(
        Long id,
        Customer customer,
        Address shipping,
        String status
) {
}
