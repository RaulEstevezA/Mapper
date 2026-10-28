<?php

declare(strict_types=1);

final class OrderApiMapper
{
    public static function toOrder(array $source): Order
    {
        return new Order(
            id: $source['orderId'],
            placedAt: new \DateTimeImmutable($source['placedAt']),
            lines: array_map(self::toOrderLine(...), $source['items']),
            tags: $source['tags'],
            coupon: ($source['coupon'] ?? null) === null ? null : (string) ($source['coupon'] ?? null) ?? throw new \InvalidArgumentException('A required value is missing in the source.'),
        );
    }

    public static function toOrderLine(array $source): OrderLine
    {
        return new OrderLine(
            productId: $source['productId'],
            name: $source['title'],
            quantity: $source['quantity'],
            price: $source['unitPrice'],
        );
    }
}
