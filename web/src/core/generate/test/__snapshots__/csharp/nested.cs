using System;

public static class OrderApiMappings
{
    public static Order ToOrder(this OrderApi source)
    {
        ArgumentNullException.ThrowIfNull(source);
        return new Order
        {
            Id = source.Id ?? throw new InvalidOperationException("A required value is missing in the source."),
            CustomerId = source.Customer.Id ?? throw new InvalidOperationException("A required value is missing in the source."),
            CustomerName = source.Customer.Name,
            ShippingAddress = source.Shipping.ToAddress(),
            Status = source.Status,
        };
    }

    public static Address ToAddress(this AddressApi source)
    {
        ArgumentNullException.ThrowIfNull(source);
        return new Address
        {
            Street = source.Street,
            City = source.City,
            PostalCode = source.ZipCode,
            Country = source.Country,
        };
    }
}
