import { type ProductResponse, ProductStatus } from './source-models'
import { ProductModel, ProductState } from './target-models'

export function mapProductResponseToProductModel(source: ProductResponse): ProductModel {
  return Object.assign(new ProductModel(), {
    sku: source.sku,
    supplier_full_name: `${source.first_name} ${source.last_name}`,
    price: source.price_cents / 100,
    status: mapProductStatusToProductState(source.status),
    active: source.status === ProductStatus.Active,
    created_at: new Date(source.created * 1000),
    stock: Number.parseInt(source.stock, 10),
    // TODO: the source may be missing, but "discount" is required
    discount: source.discount!,
  })
}

function mapProductStatusToProductState(value: ProductStatus): ProductState {
  switch (value) {
    case ProductStatus.Active:
      return ProductState.ACTIVE
    case ProductStatus.Discontinued:
      return ProductState.DISCONTINUED
    default:
      throw new Error(`Unexpected ProductStatus: ${String(value)}`)
  }
}
