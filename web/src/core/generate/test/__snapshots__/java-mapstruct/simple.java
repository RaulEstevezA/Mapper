import org.mapstruct.Mapper;
import org.mapstruct.Mapping;

@Mapper(componentModel = "spring")
public interface UserDtoMapper {

    @Mapping(target = "id", source = "userId")
    @Mapping(target = "email", source = "emailAddress")
    @Mapping(target = "active", source = "isActive")
    User toUser(UserDto source);
}
