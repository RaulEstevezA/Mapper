using System;
using AutoMapper;

public class CustomerResponseProfile : Profile
{
    public CustomerResponseProfile()
    {
        CreateMap<CustomerResponse, Customer>()
            .ForMember(dest => dest.FirstName, opt => opt.MapFrom(src => src.GivenName))
            .ForMember(dest => dest.LastName, opt => opt.MapFrom(src => src.Surname))
            .ForMember(dest => dest.Email, opt => opt.MapFrom(src => src.Mail))
            .ForMember(dest => dest.BirthDate, opt => opt.MapFrom(src => src.Dob))
            .ForMember(dest => dest.Phone, opt => opt.MapFrom(src => src.Tel))
            .ForMember(dest => dest.OrderQuantity, opt => opt.MapFrom(src => src.QtyOrders))
            .ForMember(dest => dest.CreatedAt, opt => opt.MapFrom(src => src.CreationDate));
    }
}
