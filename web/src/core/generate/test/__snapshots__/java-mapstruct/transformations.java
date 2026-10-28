import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingConstants;
import org.mapstruct.ValueMapping;

import java.math.BigDecimal;
import java.math.MathContext;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;

@Mapper(componentModel = "spring", imports = {BigDecimal.class, MathContext.class, Instant.class, OffsetDateTime.class, ZoneOffset.class})
public interface ProductResponseMapper {

    @Mapping(target = "supplierFullName", expression = "java(source.getFirstName() + \" \" + source.getLastName())")
    @Mapping(target = "price", expression = "java(BigDecimal.valueOf(source.getPriceCents()).divide(BigDecimal.valueOf(100), MathContext.DECIMAL128))")
    @Mapping(target = "active", expression = "java(source.getStatus() == ProductStatus.Active)")
    @Mapping(target = "createdAt", expression = "java(OffsetDateTime.ofInstant(Instant.ofEpochSecond((long) source.getCreated()), ZoneOffset.UTC))")
    ProductModel toProductModel(ProductResponse source);

    @ValueMapping(source = "Active", target = "ACTIVE")
    @ValueMapping(source = "Discontinued", target = "DISCONTINUED")
    @ValueMapping(source = MappingConstants.ANY_REMAINING, target = MappingConstants.THROW_EXCEPTION)
    ProductState toProductState(ProductStatus value);
}
