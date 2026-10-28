export interface Customer {
  id: number | null
  name: string
  email: string
}

export interface Address {
  street: string
  city: string
  zipCode: string
  country: string
}

export interface Order {
  id: number | null
  customer: Customer
  shipping: Address
  status: string
}
