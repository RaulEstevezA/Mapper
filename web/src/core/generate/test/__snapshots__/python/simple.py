from datetime import datetime

from models import User, UserDto


def map_user_dto_to_user(source: UserDto) -> User:
    return User(
        id=source.user_id,
        first_name=source.first_name,
        last_name=source.last_name,
        email=source.email_address,
        created_at=datetime.fromisoformat(source.created_at),
        active=source.is_active,
    )
