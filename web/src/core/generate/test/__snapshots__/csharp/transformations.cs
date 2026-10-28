using System;
using System.Globalization;

public static class ProductResponseMappings
{
    public static ProductModel ToProductModel(this ProductResponse source)
    {
        ArgumentNullException.ThrowIfNull(source);
        return new ProductModel
        {
            Sku = source.Sku,
            SupplierFullName = $"{source.FirstName} {source.LastName}",
            Price = (decimal)source.PriceCents / 100m,
            Status = ToProductState(source.Status),
            Active = source.Status == ProductStatus.Active,
            CreatedAt = DateTimeOffset.FromUnixTimeSeconds((long)source.Created).UtcDateTime,
            Stock = long.Parse(source.Stock, CultureInfo.InvariantCulture),
            Discount = source.Discount ?? throw new InvalidOperationException("A required value is missing in the source."),
        };
    }

    private static ProductState ToProductState(ProductStatus value) => value switch
    {
        ProductStatus.Active => ProductState.ACTIVE,
        ProductStatus.Discontinued => ProductState.DISCONTINUED,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, null),
    };
}
