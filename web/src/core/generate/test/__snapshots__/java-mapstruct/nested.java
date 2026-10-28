import org.mapstruct.Mapper;
import org.mapstruct.Mapping;

@Mapper(componentModel = "spring")
public interface OrderApiMapper {

    @Mapping(target = "customerId", source = "customer.id")
    @Mapping(target = "customerName", source = "customer.name")
    @Mapping(target = "shippingAddress", source = "shipping")
    Order toOrder(OrderApi source);

    @Mapping(target = "postalCode", source = "zipCode")
    Address toAddress(OrderApi.AddressApi source);
}
