package mapping

import (
	"errors"
	"fmt"
	"strconv"
	"time"
)

// MapProductResponseToProductModel maps a ProductResponse to a ProductModel. The error lists every value that could not be converted.
func MapProductResponseToProductModel(source ProductResponse) (ProductModel, error) {
	var errs []error
	target := mapProductResponseToProductModel(source, &errs)
	return target, errors.Join(errs...)
}

func mapProductResponseToProductModel(source ProductResponse, errs *[]error) ProductModel {
	return ProductModel{
		Sku: source.Sku,
		SupplierFullName: source.FirstName + " " + source.LastName,
		Price: source.PriceCents / 100.0,
		Status: toProductState(source.Status),
		Active: source.Status == ProductStatusActive,
		CreatedAt: time.Unix(int64(source.Created), 0).UTC(),
		Stock: parseInt[int64](source.Stock, errs),
		// "discount" is required: panics if the source is missing
		Discount: *source.Discount,
	}
}

func toProductState(value ProductStatus) ProductState {
	switch value {
	case ProductStatusActive:
		return ProductStateActive
	case ProductStatusDiscontinued:
		return ProductStateDiscontinued
	default:
		panic(fmt.Sprintf("unexpected ProductStatus: %v", value))
	}
}

func parseInt[T int8 | int16 | int32 | int64](text string, errs *[]error) T {
	value, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		*errs = append(*errs, err)
	}
	return T(value)
}
