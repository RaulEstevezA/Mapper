import type { UserDto } from './source-models'
import type { User } from './target-models'

export function mapUserDtoToUser(source: UserDto): User {
  return {
    id: source.userId,
    firstName: source.firstName,
    lastName: source.lastName,
    email: source.emailAddress,
    createdAt: new Date(source.createdAt),
    active: source.isActive,
  }
}
