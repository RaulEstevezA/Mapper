public class Customer
{
    public required long CustomerId { get; set; }
    public required string GivenName { get; set; }
    public required string Surname { get; set; }
    public required string Mail { get; set; }
    public required DateOnly Dob { get; set; }
    public required string Tel { get; set; }
    public required long QtyOrders { get; set; }
    public required DateTime CreationDate { get; set; }
}
