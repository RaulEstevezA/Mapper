using System;
using AutoMapper;

public class OrderApiProfile : Profile
{
    public OrderApiProfile()
    {
        CreateMap<OrderApi, Order>()
            .ForMember(dest => dest.CustomerId, opt => opt.MapFrom(src => src.Customer.Id))
            .ForMember(dest => dest.CustomerName, opt => opt.MapFrom(src => src.Customer.Name))
            .ForMember(dest => dest.ShippingAddress, opt => opt.MapFrom(src => src.Shipping));

        CreateMap<AddressApi, Address>()
            .ForMember(dest => dest.PostalCode, opt => opt.MapFrom(src => src.ZipCode));
    }
}
