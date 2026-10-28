import org.mapstruct.Mapper;
import org.mapstruct.Mapping;

@Mapper(componentModel = "spring")
public interface CustomerResponseMapper {

    @Mapping(target = "firstName", source = "givenName")
    @Mapping(target = "lastName", source = "surname")
    @Mapping(target = "email", source = "mail")
    @Mapping(target = "birthDate", source = "dob")
    @Mapping(target = "phone", source = "tel")
    @Mapping(target = "orderQuantity", source = "qtyOrders")
    @Mapping(target = "createdAt", source = "creationDate")
    Customer toCustomer(CustomerResponse source);
}
