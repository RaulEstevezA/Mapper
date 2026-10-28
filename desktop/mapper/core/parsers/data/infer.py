"""Infers models from an example document (JSON, YAML, XML or CSV, all read as a JsonValue). Mirrors
web/src/core/parsers/data/infer.ts. Arrays of objects are merged, so a key missing in some items is optional
and a key that is null in some is nullable."""

import re
from typing import Any

from ...js import number_text
from ...model.naming import singularize, to_pascal_case, unique_name
from ...model.schema import empty_schema, primitive

_FORMATS = (
    (
        "datetime",
        re.compile(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?"
        ),
    ),
    ("date", re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")),
    ("time", re.compile(r"[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?")),
    ("uuid", re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)),
)
_FORMAT_NAMES = [name for name, _ in _FORMATS]


class _Stats:
    __slots__ = ("count", "nulls", "strings", "formats", "integers", "floats", "booleans", "object", "array", "arrays")

    def __init__(self):
        self.count = 0
        self.nulls = 0
        self.strings = 0
        # Formats every string seen so far matches; emptied by the first plain text
        self.formats: set[str] | None = None
        self.integers = 0
        self.floats = 0
        self.booleans = 0
        self.object: _ObjectStats | None = None
        # Elements of the arrays seen at this place
        self.array: _Stats | None = None
        self.arrays = 0


class _ObjectStats:
    def __init__(self):
        self.count = 0
        # key → [present, stats], in the order keys are first seen
        self.keys: dict[str, list] = {}


def _string_formats(value: str) -> set[str]:
    return {name for name, pattern in _FORMATS if pattern.fullmatch(value)}


def _collect(stats: _Stats, value: dict) -> None:
    stats.count += 1
    kind = value["kind"]
    if kind == "null":
        stats.nulls += 1
    elif kind == "string":
        formats = _string_formats(value["value"])
        stats.formats = (
            formats if stats.strings == 0 else {item for item in (stats.formats or set()) if item in formats}
        )
        stats.strings += 1
    elif kind == "number":
        if value["integer"]:
            stats.integers += 1
        else:
            stats.floats += 1
    elif kind == "boolean":
        stats.booleans += 1
    elif kind == "array":
        stats.arrays += 1
        if stats.array is None:
            stats.array = _Stats()
        for item in value["items"]:
            _collect(stats.array, item)
    elif kind == "object":
        if stats.object is None:
            stats.object = _ObjectStats()
        stats.object.count += 1
        seen: set[str] = set()
        for key, child in value["entries"]:
            # A repeated key: JSON.parse would keep the last one; it is the same field either way
            if key in seen:
                continue
            seen.add(key)
            entry = stats.object.keys.get(key)
            if entry is None:
                entry = [0, _Stats()]
                stats.object.keys[key] = entry
            entry[0] += 1
            _collect(entry[1], child)


class _Context:
    def __init__(self):
        self.models: list[dict] = []
        self.used_names: set[str] = set()
        self.warnings: list[dict] = []


def _scalar_type(stats: _Stats, path: str, context: _Context) -> dict:
    kinds = sum(
        [
            stats.strings > 0,
            stats.integers + stats.floats > 0,
            stats.booleans > 0,
            stats.object is not None,
            stats.arrays > 0,
        ]
    )
    if kinds == 0:
        return primitive("any")
    if kinds > 1:
        context.warnings.append({"code": "mixedTypes", "params": {"field": path}})
        return primitive("any")
    if stats.strings > 0:
        found = next((name for name in _FORMAT_NAMES if stats.formats and name in stats.formats), None)
        return primitive(found or "string")
    if stats.floats > 0:
        return primitive("float")
    if stats.integers > 0:
        return primitive("integer")
    return primitive("boolean")


def _resolve(stats: _Stats, name_hint: str, path: str, context: _Context) -> dict:
    if stats.object and stats.strings + stats.integers + stats.floats + stats.booleans + stats.arrays == 0:
        return {"kind": "model", "name": _build_model(stats.object, name_hint, path, context)}
    if stats.array and stats.strings + stats.integers + stats.floats + stats.booleans == 0 and not stats.object:
        items = stats.array
        inner = _resolve(items, _singular_name(name_hint), f"{path}[]", context)
        type_ref: dict = {"kind": "array", "items": inner}
        if 0 < items.nulls < items.count:
            type_ref["itemsNullable"] = True
        return type_ref
    return _scalar_type(stats, path, context)


def _singular_name(name: str) -> str:
    pascal = to_pascal_case(name)
    singular = singularize(pascal)
    return f"{pascal}Item" if singular == pascal else singular


def _build_model(object_stats: _ObjectStats, name: str, path: str, context: _Context) -> str:
    model_name = unique_name(to_pascal_case(name) or "Model", context.used_names)
    model: dict = {"name": model_name, "kind": "object", "fields": []}
    # Added before the fields so nested models come after their parent, in reading order
    context.models.append(model)
    for key, (present, stats) in object_stats.keys.items():
        type_ref = _resolve(stats, key, f"{path}.{key}" if path else key, context)
        model["fields"].append(
            {"name": key, "type": type_ref, "nullable": stats.nulls > 0, "optional": present < object_stats.count}
        )
    if not model["fields"]:
        context.warnings.append({"code": "emptyModel", "params": {"model": model_name}})
    return model_name


def infer_schema(value: dict, root_name: str, format_id: str) -> dict | None:
    """Models described by an example document: {"schema", "warnings"}. None when the document has no object
    at all (a bare number, an array of strings): there is nothing to map."""
    stats = _Stats()
    _collect(stats, value)
    # An array at the root is a list of the root model ([{...}, {...}])
    root = stats
    while not root.object and root.array:
        root = root.array
    if not root.object:
        return None
    context = _Context()
    # users: [...] holds users: the model of a list is named in singular
    name = _build_model(
        root.object, root_name if root is stats else singularize(to_pascal_case(root_name)), "", context
    )
    schema = empty_schema({"format": format_id})
    schema["models"] = context.models
    schema["root"] = name
    return {"schema": schema, "warnings": context.warnings}


_INDEX_KEY = re.compile(r"0|[1-9][0-9]*")


def _js_key(key: Any) -> str:
    if key is None:
        return "null"
    if isinstance(key, (bool, int, float)):
        return number_text(key) if not isinstance(key, bool) else ("true" if key else "false")
    return str(key)


def from_plain_value(value: Any) -> dict:
    """Plain value (from the YAML parser) as a JsonValue, the way a JavaScript object would hold it."""
    if value is None:
        return {"kind": "null"}
    if isinstance(value, bool):
        return {"kind": "boolean", "value": value}
    if isinstance(value, str):
        return {"kind": "string", "value": value}
    if isinstance(value, int):
        return {"kind": "number", "text": number_text(value), "integer": True}
    if isinstance(value, float):
        integer = value == value and value not in (float("inf"), float("-inf")) and value == int(value)
        return {"kind": "number", "text": number_text(value), "integer": integer}
    if isinstance(value, list):
        return {"kind": "array", "items": [from_plain_value(item) for item in value]}
    if isinstance(value, dict):
        entries: dict[str, Any] = {}
        for key, item in value.items():
            entries[_js_key(key)] = item
        # A JavaScript object lists keys that look like array indices first, in numeric order
        indices = sorted((key for key in entries if _INDEX_KEY.fullmatch(key) and int(key) < 2**32 - 1), key=int)
        others = [key for key in entries if key not in set(indices)]
        return {"kind": "object", "entries": [(key, from_plain_value(entries[key])) for key in indices + others]}
    return {"kind": "string", "value": str(value)}
