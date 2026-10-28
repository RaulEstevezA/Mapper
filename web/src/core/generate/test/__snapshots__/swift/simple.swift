import Foundation

extension UserDto {
    func toUser() -> User {
        User(
            id: userId,
            firstName: firstName,
            lastName: lastName,
            email: emailAddress,
            createdAt: ISO8601DateFormatter().date(from: createdAt)!,
            active: isActive
        )
    }
}
