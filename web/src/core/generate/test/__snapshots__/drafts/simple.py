from dataclasses import dataclass


@dataclass
class User:
    user_id: float
    first_name: str
    last_name: str
    email_address: str
    created_at: str
    is_active: bool
