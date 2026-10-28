import java.time.Instant

fun UserDto.toUser(): User = User(
    id = userId,
    firstName = firstName,
    lastName = lastName,
    email = emailAddress,
    createdAt = Instant.parse(createdAt),
    active = isActive,
)
