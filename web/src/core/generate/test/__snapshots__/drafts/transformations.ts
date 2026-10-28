export enum ProductStatus {
  Active = "ACTIVE",
  Discontinued = "DISCONTINUED",
  Draft = "DRAFT",
}

export interface Product {
  sku: string
  firstName: string
  lastName: string
  priceCents: number
  status: ProductStatus
  created: number
  stock: string
  discount: number | null
}
