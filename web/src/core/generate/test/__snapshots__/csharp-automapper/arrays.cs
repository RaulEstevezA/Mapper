using System;
using AutoMapper;

public class OrderApiProfile : Profile
{
    public OrderApiProfile()
    {
        CreateMap<OrderApi, Order>()
            .ForMember(dest => dest.Id, opt => opt.MapFrom(src => src.OrderId))
            .ForMember(dest => dest.Lines, opt => opt.MapFrom(src => src.Items));

        CreateMap<Item, OrderLine>()
            .ForMember(dest => dest.Name, opt => opt.MapFrom(src => src.Title))
            .ForMember(dest => dest.Price, opt => opt.MapFrom(src => src.UnitPrice));
    }
}
