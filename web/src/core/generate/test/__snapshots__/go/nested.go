package mapping

// MapOrderApiToOrder maps a OrderApi to a Order.
func MapOrderApiToOrder(source OrderApi) Order {
	return mapOrderApiToOrder(source)
}

func mapOrderApiToOrder(source OrderApi) Order {
	return Order{
		// "Id" is required: panics if the source is missing
		ID: *source.ID,
		// "CustomerId" is required: panics if the source is missing
		CustomerID: *source.Customer.ID,
		CustomerName: pointerTo(source.Customer.Name),
		ShippingAddress: pointerTo(mapAddressApiToAddress(source.Shipping)),
		Status: pointerTo(source.Status),
	}
}

func mapAddressApiToAddress(source AddressApi) Address {
	return Address{
		Street: pointerTo(source.Street),
		City: pointerTo(source.City),
		PostalCode: pointerTo(source.ZipCode),
		Country: pointerTo(source.Country),
	}
}

func pointerTo[T any](value T) *T {
	return &value
}
