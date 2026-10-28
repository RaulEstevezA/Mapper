import Foundation

extension ProductResponse {
    func toProductModel() -> ProductModel {
        ProductModel(
            sku: sku,
            supplierFullName: "\(firstName) \(lastName)",
            price: Decimal(priceCents) / 100,
            status: toProductState(status),
            active: status == .active,
            createdAt: Date(timeIntervalSince1970: TimeInterval(created)),
            stock: Int(stock)!,
            discount: discount!
        )
    }
}

private func toProductState(_ value: ProductStatus) -> ProductState {
    switch value {
    case .active: return .active
    case .discontinued: return .discontinued
    default: fatalError("Unexpected ProductStatus: \(value)")
    }
}
