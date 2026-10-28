import org.mapstruct.Mapper;
import org.mapstruct.Mapping;

@Mapper(componentModel = "spring")
public interface OrderApiMapper {

    @Mapping(target = "id", source = "orderId")
    @Mapping(target = "lines", source = "items")
    Order toOrder(OrderApi source);

    @Mapping(target = "name", source = "title")
    @Mapping(target = "price", source = "unitPrice")
    OrderLine toOrderLine(Item source);
}
