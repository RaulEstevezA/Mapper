<?php

declare(strict_types=1);

final class CustomerResponseMapper
{
    public static function toCustomer(array $source): Customer
    {
        return new Customer(
            customerId: $source['customer_id'],
            firstName: $source['given_name'],
            lastName: $source['surname'],
            email: $source['mail'],
            birthDate: new \DateTimeImmutable($source['dob']),
            phone: $source['tel'],
            orderQuantity: $source['qty_orders'],
            createdAt: new \DateTimeImmutable($source['creation_date']),
        );
    }
}
