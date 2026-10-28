<?php

declare(strict_types=1);

final class ProductResponseMapper
{
    public static function toProductModel(ProductResponse $source): ProductModel
    {
        return new ProductModel(
            sku: $source->sku,
            supplierFullName: $source->firstName . ' ' . $source->lastName,
            price: $source->priceCents / 100,
            status: self::toProductState($source->status),
            active: $source->status === ProductStatus::Active,
            createdAt: (new \DateTimeImmutable())->setTimestamp((int) $source->created),
            stock: (int) $source->stock,
            discount: $source->discount ?? throw new \InvalidArgumentException('A required value is missing in the source.'),
        );
    }

    private static function toProductState(ProductStatus $value): ProductState
    {
        return match ($value) {
            ProductStatus::Active => ProductState::ACTIVE,
            ProductStatus::Discontinued => ProductState::DISCONTINUED,
            default => throw new \UnexpectedValueException('Unexpected ProductStatus'),
        };
    }
}
