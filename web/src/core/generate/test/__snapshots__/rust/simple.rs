use chrono::DateTime;
use chrono::Utc;
use crate::models::{User, UserDto};

impl From<&UserDto> for User {
    fn from(source: &UserDto) -> Self {
        Self {
            id: source.user_id,
            first_name: source.first_name.clone(),
            last_name: source.last_name.clone(),
            email: source.email_address.clone(),
            created_at: source.created_at.parse::<DateTime<Utc>>().expect("date and time is not valid"),
            active: source.is_active,
        }
    }
}
