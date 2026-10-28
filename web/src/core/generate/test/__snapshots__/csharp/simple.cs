using System;
using System.Globalization;

public static class UserDtoMappings
{
    public static User ToUser(this UserDto source)
    {
        ArgumentNullException.ThrowIfNull(source);
        return new User
        {
            Id = source.UserId,
            FirstName = source.FirstName,
            LastName = source.LastName,
            Email = source.EmailAddress,
            CreatedAt = DateTime.Parse(source.CreatedAt, CultureInfo.InvariantCulture),
            Active = source.IsActive,
        };
    }
}
