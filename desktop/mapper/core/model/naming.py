"""Splitting names into words and converting between conventions. Mirrors web/src/core/model/naming.ts,
adapted from Api2Class: both tools split and convert names the same way."""

import re
import unicodedata
from functools import lru_cache
from typing import Literal

NamingConvention = Literal["PascalCase", "camelCase", "snake_case", "SCREAMING_SNAKE_CASE"]


def _category(char: str) -> str:
    return unicodedata.category(char)


def split_words(text: str) -> list[str]:
    """Splits a name into words: postal_code, postalCode, PostalCode, postal-code and Postal Code all give
    ["postal", "code"]. Accents are removed (teléfono → telefono) and digits stay with the word before them
    (address2)."""
    return list(_split(text))


# The matching engine splits the same names many times: they are worked out once
@lru_cache(maxsize=20000)
def _split(text: str) -> tuple[str, ...]:
    plain = "".join(char for char in unicodedata.normalize("NFD", text) if _category(char)[0] != "M")
    words: list[str] = []
    current = ""
    for index, char in enumerate(plain):
        if _category(char)[0] not in "LN":
            if current:
                words.append(current)
            current = ""
            continue
        if current:
            previous = current[-1]
            following = plain[index + 1] if index + 1 < len(plain) else ""
            # userId → user Id; HTTPServer → HTTP Server
            if _category(char) == "Lu" and (
                _category(previous) == "Ll"
                or _category(previous)[0] == "N"
                or (_category(previous) == "Lu" and following != "" and _category(following) == "Ll")
            ):
                words.append(current)
                current = ""
        current += char
    if current:
        words.append(current)
    return tuple(words)


def _capitalize(word: str) -> str:
    return word[:1].upper() + word[1:].lower()


def to_pascal_case(text: str) -> str:
    return "".join(_capitalize(word) for word in split_words(text))


def to_camel_case(text: str) -> str:
    pascal = to_pascal_case(text)
    words = split_words(text)
    first = words[0] if words else ""
    return first.lower() + pascal[len(first) :]


def to_snake_case(text: str) -> str:
    return "_".join(word.lower() for word in split_words(text))


def to_screaming_snake_case(text: str) -> str:
    return to_snake_case(text).upper()


def convert_case(text: str, convention: NamingConvention) -> str:
    if convention == "PascalCase":
        return to_pascal_case(text)
    if convention == "camelCase":
        return to_camel_case(text)
    if convention == "SCREAMING_SNAKE_CASE":
        return to_screaming_snake_case(text)
    return to_snake_case(text)


def name_words(text: str) -> list[str]:
    """Lowercase words of a name, for comparing names written in different conventions: userId, user_id,
    UserID and user-id all give ["user", "id"]."""
    return [word.lower() for word in split_words(text)]


# Already singular, or the same in singular and plural
_UNCHANGED = {"data", "metadata", "news", "series", "species", "info", "information", "media", "status"}
_IRREGULAR = {
    "people": "person",
    "children": "child",
    "men": "man",
    "women": "woman",
    # -ies plurals of words ending in -ie
    "movies": "movie",
    "cookies": "cookie",
}


def singularize(word: str) -> str:
    """English singular of one word, keeping its case: Categories → Category, addresses → address.
    Returns the word unchanged when it does not look like a plural."""
    lower = word.lower()
    if lower in _UNCHANGED:
        return word
    if lower in _IRREGULAR:
        return word[:1] + _IRREGULAR[lower][1:]
    if re.search(r"[^aeiou]ies$", lower):
        return word[:-3] + ("Y" if word.endswith("IES") else "y")
    if re.search(r"(ss|us|x|z|ch|sh)es$", lower):
        return word[:-2]
    if re.search(r"(ss|us|is)$", lower) or not lower.endswith("s") or len(lower) < 3:
        return word
    return word[:-1]


def safe_identifier(name: str, reserved: set[str] | frozenset[str], fallback: str) -> str:
    """Makes a name usable as an identifier: never empty, not starting with a digit and not a reserved word."""
    if name == "":
        return fallback
    if _category(name[0])[0] == "N":
        return f"_{name}"
    if name in reserved:
        return f"{name}_"
    return name


def unique_name(name: str, used: set[str]) -> str:
    """Returns name, or name2, name3... if it is already taken, and marks the result as taken."""
    result = name
    n = 2
    while result in used:
        result = f"{name}{n}"
        n += 1
    used.add(result)
    return result
