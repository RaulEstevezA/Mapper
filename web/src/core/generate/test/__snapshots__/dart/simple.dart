import 'models.dart';

extension UserDtoMapping on UserDto {
  User toUser() => User(
        id: userId,
        firstName: firstName,
        lastName: lastName,
        email: emailAddress,
        createdAt: DateTime.parse(createdAt),
        active: isActive,
      );
}
