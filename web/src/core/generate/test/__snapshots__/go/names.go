package mapping

// MapCustomerResponseToCustomer maps a CustomerResponse to a Customer.
func MapCustomerResponseToCustomer(source CustomerResponse) Customer {
	return mapCustomerResponseToCustomer(source)
}

func mapCustomerResponseToCustomer(source CustomerResponse) Customer {
	return Customer{
		CustomerID: source.CustomerID,
		FirstName: source.GivenName,
		LastName: source.Surname,
		Email: source.Mail,
		BirthDate: source.Dob,
		Phone: pointerTo(source.Tel),
		OrderQuantity: int32(source.QtyOrders),
		CreatedAt: source.CreationDate,
	}
}

func pointerTo[T any](value T) *T {
	return &value
}
