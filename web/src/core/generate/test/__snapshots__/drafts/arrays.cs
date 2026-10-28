public class Item
{
    public required long ProductId { get; set; }
    public required string Title { get; set; }
    public required long Quantity { get; set; }
    public required double UnitPrice { get; set; }
}

public class Order
{
    public required string OrderId { get; set; }
    public required DateTime PlacedAt { get; set; }
    public required List<Item> Items { get; set; }
    public required List<string> Tags { get; set; }
    public object? Coupon { get; set; }
}
