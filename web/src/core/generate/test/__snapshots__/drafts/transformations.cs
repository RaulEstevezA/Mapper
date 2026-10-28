public enum ProductStatus
{
    Active,
    Discontinued,
    Draft
}

public class Product
{
    public required string Sku { get; set; }
    public required string FirstName { get; set; }
    public required string LastName { get; set; }
    public required double PriceCents { get; set; }
    public required ProductStatus Status { get; set; }
    public required double Created { get; set; }
    public required string Stock { get; set; }
    public double? Discount { get; set; }
}
