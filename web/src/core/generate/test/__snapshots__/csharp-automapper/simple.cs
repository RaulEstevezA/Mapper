using System;
using AutoMapper;

public class UserDtoProfile : Profile
{
    public UserDtoProfile()
    {
        CreateMap<UserDto, User>()
            .ForMember(dest => dest.Id, opt => opt.MapFrom(src => src.UserId))
            .ForMember(dest => dest.Email, opt => opt.MapFrom(src => src.EmailAddress))
            .ForMember(dest => dest.Active, opt => opt.MapFrom(src => src.IsActive));
    }
}
