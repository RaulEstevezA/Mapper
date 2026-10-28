export interface Item {
  productId: number
  title: string
  quantity: number
  unitPrice: number
}

export interface Order {
  orderId: string
  placedAt: Date
  items: Item[]
  tags: string[]
  coupon: unknown | null
}
