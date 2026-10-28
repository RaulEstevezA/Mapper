import type { Item, OrderApi } from './source-models'
import type { Order, OrderLine } from './target-models'

export function mapOrderApiToOrder(source: OrderApi): Order {
  return {
    id: source.orderId,
    placedAt: new Date(source.placedAt),
    lines: source.items.map(mapItemToOrderLine),
    tags: [...source.tags],
    // TODO: the source may be missing, but "coupon" is required
    coupon: (source.coupon == null ? undefined : String(source.coupon))!,
  }
}

export function mapItemToOrderLine(source: Item): OrderLine {
  return {
    productId: source.productId,
    name: source.title,
    quantity: source.quantity,
    price: source.unitPrice,
  }
}
