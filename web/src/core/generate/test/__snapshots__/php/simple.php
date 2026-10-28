<?php

declare(strict_types=1);

final class UserDtoMapper
{
    public static function toUser(UserDto $source): User
    {
        $target = new User();
        $target->id = $source->userId;
        $target->firstName = $source->firstName;
        $target->lastName = $source->lastName;
        $target->email = $source->emailAddress;
        $target->createdAt = new \DateTimeImmutable($source->createdAt);
        $target->active = $source->isActive;
        return $target;
    }
}
