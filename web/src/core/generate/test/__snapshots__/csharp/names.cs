using System;

public static class CustomerResponseMappings
{
    public static Customer ToCustomer(this CustomerResponse source)
    {
        ArgumentNullException.ThrowIfNull(source);
        return new Customer
        {
            CustomerId = source.CustomerId,
            FirstName = source.GivenName,
            LastName = source.Surname,
            Email = source.Mail,
            BirthDate = source.Dob,
            Phone = source.Tel,
            OrderQuantity = checked((int)source.QtyOrders),
            CreatedAt = source.CreationDate,
        };
    }
}
