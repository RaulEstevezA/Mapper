import 'models.dart';

extension ProductResponseMapping on ProductResponse {
  ProductModel toProductModel() => ProductModel(
        sku: sku,
        supplierFullName: '${firstName} ${lastName}',
        price: priceCents / 100,
        status: _toProductState(status),
        active: status == ProductStatus.active,
        createdAt: DateTime.fromMillisecondsSinceEpoch((created * 1000).round(), isUtc: true),
        stock: int.parse(stock),
        discount: discount!,
      );
}

ProductState _toProductState(ProductStatus value) => switch (value) {
      ProductStatus.active => ProductState.active,
      ProductStatus.discontinued => ProductState.discontinued,
      _ => throw ArgumentError.value(value, 'value', 'Unexpected ProductStatus'),
    };
