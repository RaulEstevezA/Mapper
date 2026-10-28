<?php

declare(strict_types=1);

final class OrderApiMapper
{
    public static function toOrder(OrderApi $source): Order
    {
        $target = new Order();
        $target->id = $source->getId() ?? throw new \InvalidArgumentException('A required value is missing in the source.');
        $target->customerId = $source->getCustomer()->getId() ?? throw new \InvalidArgumentException('A required value is missing in the source.');
        $target->customerName = $source->getCustomer()->getName();
        $target->shippingAddress = self::toAddress($source->getShipping());
        $target->status = $source->getStatus();
        return $target;
    }

    public static function toAddress(AddressApi $source): Address
    {
        $target = new Address();
        $target->street = $source->getStreet();
        $target->city = $source->getCity();
        $target->postalCode = $source->getZipCode();
        $target->country = $source->getCountry();
        return $target;
    }
}
