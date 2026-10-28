import java.time.OffsetDateTime;

public final class UserDtoMapper {

    private UserDtoMapper() {
    }

    public static User toUser(UserDto source) {
        if (source == null) {
            return null;
        }
        User target = new User();
        target.setId(source.getUserId());
        target.setFirstName(source.getFirstName());
        target.setLastName(source.getLastName());
        target.setEmail(source.getEmailAddress());
        target.setCreatedAt(OffsetDateTime.parse(source.getCreatedAt()));
        target.setActive(source.getIsActive());
        return target;
    }
}
