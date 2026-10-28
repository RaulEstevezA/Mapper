using System;
using AutoMapper;

public class ProductResponseProfile : Profile
{
    public ProductResponseProfile()
    {
        CreateMap<ProductResponse, ProductModel>()
            .ForMember(dest => dest.SupplierFullName, opt => opt.MapFrom(src => $"{src.FirstName} {src.LastName}"))
            .ForMember(dest => dest.Price, opt => opt.MapFrom(src => (decimal)src.PriceCents / 100m))
            .ForMember(dest => dest.Status, opt => opt.MapFrom(src => ToProductState(src.Status)))
            .ForMember(dest => dest.Active, opt => opt.MapFrom(src => src.Status == ProductStatus.Active))
            .ForMember(dest => dest.CreatedAt, opt => opt.MapFrom(src => DateTimeOffset.FromUnixTimeSeconds((long)src.Created).UtcDateTime));

        CreateMap<ProductStatus, ProductState>().ConvertUsing(value => ToProductState(value));
    }

    private static ProductState ToProductState(ProductStatus value) => value switch
    {
        ProductStatus.Active => ProductState.ACTIVE,
        ProductStatus.Discontinued => ProductState.DISCONTINUED,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, null),
    };
}
