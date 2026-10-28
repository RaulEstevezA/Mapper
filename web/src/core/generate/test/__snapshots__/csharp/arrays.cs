using System;
using System.Linq;

public static class OrderApiMappings
{
    public static Order ToOrder(this OrderApi source)
    {
        ArgumentNullException.ThrowIfNull(source);
        return new Order(
            source.OrderId,
            source.PlacedAt,
            source.Items.Select(item => item.ToOrderLine()).ToList(),
            source.Tags.ToHashSet(),
            source.Coupon is { } value ? value.ToString() : null ?? throw new InvalidOperationException("A required value is missing in the source.")
        );
    }

    public static OrderLine ToOrderLine(this Item source)
    {
        ArgumentNullException.ThrowIfNull(source);
        return new OrderLine(
            source.ProductId,
            source.Title,
            checked((int)source.Quantity),
            (decimal)source.UnitPrice
        );
    }
}
