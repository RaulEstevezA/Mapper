package mapping

import (
	"errors"
	"time"
)

// MapUserDtoToUser maps a UserDto to a User. The error lists every value that could not be converted.
func MapUserDtoToUser(source UserDto) (User, error) {
	var errs []error
	target := mapUserDtoToUser(source, &errs)
	return target, errors.Join(errs...)
}

func mapUserDtoToUser(source UserDto, errs *[]error) User {
	return User{
		ID: source.UserID,
		FirstName: source.FirstName,
		LastName: source.LastName,
		Email: source.EmailAddress,
		CreatedAt: parseTime(source.CreatedAt, time.RFC3339, errs),
		Active: source.IsActive,
	}
}

func parseTime(text, layout string, errs *[]error) time.Time {
	value, err := time.Parse(layout, text)
	if err != nil {
		*errs = append(*errs, err)
	}
	return value
}
