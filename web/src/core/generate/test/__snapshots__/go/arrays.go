package mapping

import "fmt"

// MapOrderApiToOrder maps a OrderApi to a Order.
func MapOrderApiToOrder(source OrderApi) Order {
	return mapOrderApiToOrder(source)
}

func mapOrderApiToOrder(source OrderApi) Order {
	return Order{
		ID: source.OrderID,
		PlacedAt: source.PlacedAt,
		Lines: mapSlice(source.Items, mapItemToOrderLine),
		Tags: source.Tags,
		// "coupon" is required: panics if the source is missing
		Coupon: *mapPointer(source.Coupon, func(value any) string {
			return fmt.Sprint(value)
		}),
	}
}

func mapItemToOrderLine(source Item) OrderLine {
	return OrderLine{
		ProductID: source.ProductID,
		Name: source.Title,
		Quantity: int32(source.Quantity),
		Price: source.UnitPrice,
	}
}

func mapPointer[T, R any](value *T, mapValue func(T) R) *R {
	if value == nil {
		return nil
	}
	result := mapValue(*value)
	return &result
}

func mapSlice[T, R any](items []T, mapItem func(T) R) []R {
	if items == nil {
		return nil
	}
	result := make([]R, len(items))
	for index, item := range items {
		result[index] = mapItem(item)
	}
	return result
}
