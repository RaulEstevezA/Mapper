/**
 * @param {UserDto} source
 * @returns {User}
 */
export function mapUserDtoToUser(source) {
  return {
    id: source.userId,
    firstName: source.firstName,
    lastName: source.lastName,
    email: source.emailAddress,
    createdAt: new Date(source.createdAt),
    active: source.isActive,
  }
}
