"""JavaScript string behavior the port depends on: trim() removes a slightly different set of
characters than str.strip() (the byte order mark, but not the ASCII separators \\x1c-\\x1f)."""

import math

WHITESPACE = "\t\n\v\f\r                  　﻿"


def trim(text: str) -> str:
    return text.strip(WHITESPACE)


def trim_start(text: str) -> str:
    return text.lstrip(WHITESPACE)


def trim_end(text: str) -> str:
    return text.rstrip(WHITESPACE)


def number_text(value: float | int) -> str:
    """String(value) of a JavaScript number: 2.0 → "2", 1e21 → "1e+21", 1e-7 → "1e-7"."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        value = float(value) if abs(value) >= 1e21 else value
        if isinstance(value, int):
            return str(value)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))
    text = repr(value)
    if "e" in text:
        mantissa, exponent = text.split("e")
        sign = "-" if exponent.startswith("-") else "+"
        return f"{mantissa}e{sign}{int(exponent.lstrip('+-'))}"
    return text


def number(text: str) -> int | float:
    """Number(text) for a decimal literal: an integral value is an int, as JSON writes it (1.0 → 1)."""
    value = float(text)
    return int(value) if value.is_integer() and abs(value) < 2**53 else value


def json_string(text: str) -> str:
    """JSON.stringify of a string."""
    import json

    return json.dumps(text, ensure_ascii=False)


def coalesce(*values):
    """a ?? b ?? c: the first value that is not None (an empty string counts as a value)."""
    return next((value for value in values if value is not None), None)


_INDEX_LIMIT = 2**32 - 1


def _is_index_key(key: str) -> bool:
    return key.isdigit() and key.isascii() and (key == "0" or not key.startswith("0")) and int(key) < _INDEX_LIMIT


def js_object(pairs) -> dict:
    """A dictionary with the key order of a JavaScript object: keys that look like array indices first, in
    numeric order, then the rest in insertion order. A repeated key keeps its first place and its last value."""
    result: dict = {}
    for key, value in pairs:
        result[key] = value
    if not any(_is_index_key(key) for key in result):
        return result
    indices = sorted((key for key in result if _is_index_key(key)), key=int)
    ordered = {key: result[key] for key in indices}
    ordered.update((key, value) for key, value in result.items() if not _is_index_key(key))
    return ordered


def _parse_number(text: str):
    value = float(text)
    if value.is_integer() and abs(value) < 2**53:
        return int(value)
    return value


def parse_json_value(text: str):
    """JSON.parse: objects with JavaScript's key order and integral numbers as int (1.0 is 1)."""
    import json

    return json.loads(text, object_pairs_hook=js_object, parse_float=_parse_number, parse_int=_parse_number)


def key_text(key) -> str:
    """String(key) for a key of a YAML mapping, which may be a number, a boolean or null."""
    if isinstance(key, str):
        return key
    return js_string(key)


def to_js_value(value):
    """A value read from YAML as JavaScript would hold it: string keys in JavaScript order."""
    if isinstance(value, dict):
        return js_object((key_text(key), to_js_value(item)) for key, item in value.items())
    if isinstance(value, list):
        return [to_js_value(item) for item in value]
    if isinstance(value, float) and value.is_integer() and abs(value) < 2**53:
        return int(value)
    return value


def js_string(value) -> str:
    """String(value) of a JSON value."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return number_text(value)
    if isinstance(value, list):
        return ",".join("" if item is None else js_string(item) for item in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


def is_number(value) -> bool:
    """typeof value === 'number' (booleans are not numbers)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def to_number(text: str):
    """Number(text): decimal, 0x, 0o and 0b literals; None (NaN, which JSON writes as null) for anything else."""
    value = trim(text)
    try:
        lower = value.lower()
        if lower.startswith(("0x", "0o", "0b")):
            return int(value[2:], {"x": 16, "o": 8, "b": 2}[lower[1]])
        return _parse_number(value) if value else 0
    except ValueError:
        return None
