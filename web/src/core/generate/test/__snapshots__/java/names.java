public final class CustomerResponseMapper {

    private CustomerResponseMapper() {
    }

    public static Customer toCustomer(CustomerResponse source) {
        if (source == null) {
            return null;
        }
        return new Customer(
                (long) source.getCustomerId(),
                source.getGivenName(),
                source.getSurname(),
                source.getMail(),
                source.getDob(),
                source.getTel(),
                Math.toIntExact(source.getQtyOrders()),
                source.getCreationDate()
        );
    }
}
