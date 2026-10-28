import java.util.Objects;

public final class OrderApiMapper {

    private OrderApiMapper() {
    }

    public static Order toOrder(OrderApi source) {
        if (source == null) {
            return null;
        }
        Order target = new Order();
        // "Id" is required: fails if the source is missing
        target.setId(Objects.requireNonNull(source.getId()));
        // "CustomerId" is required: fails if the source is missing
        target.setCustomerId(Objects.requireNonNull(source.getCustomer().getId()));
        target.setCustomerName(source.getCustomer().getName());
        target.setShippingAddress(toAddress(source.getShipping()));
        target.setStatus(source.getStatus());
        return target;
    }

    public static Address toAddress(OrderApi.AddressApi source) {
        if (source == null) {
            return null;
        }
        Address target = new Address();
        target.setStreet(source.getStreet());
        target.setCity(source.getCity());
        target.setPostalCode(source.getZipCode());
        target.setCountry(source.getCountry());
        return target;
    }
}
