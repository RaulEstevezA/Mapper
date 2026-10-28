public class Customer
{
    public long? Id { get; set; }
    public required string Name { get; set; }
    public required string Email { get; set; }
}

public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string ZipCode { get; set; }
    public required string Country { get; set; }
}

public class Order
{
    public long? Id { get; set; }
    public required Customer Customer { get; set; }
    public required Address Shipping { get; set; }
    public required string Status { get; set; }
}
