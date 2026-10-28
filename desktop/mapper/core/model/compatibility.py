"""How a source value can become a target value. Mirrors web/src/core/model/compatibility.ts.

The result is a dictionary {"level", "fallible"?, "lossy"?, "items"?}, with these levels:
- same: assigned as is.
- widening: assigned as is or with a cast that never loses information (int → long, date → datetime).
- conversion: needs a conversion the generators write automatically ("123" → 123, 12 → "12").
- transform: needs a transformation the user chooses (epoch seconds → datetime, string → boolean).
- nested: two models; mapped with another model mapping.
- collection: two collections; mapped element by element ("items" says how).
- incompatible: there is no sensible way (an object into a number).
"""

from typing import Any

from .schema import TypeRef

Compatibility = dict[str, Any]

_NUMBERS = {"integer", "float", "decimal"}
_PARSED_FROM_TEXT = {"integer", "float", "decimal", "date", "datetime", "time", "duration", "uuid"}


def _primitive_compatibility(source: TypeRef, target: TypeRef) -> Compatibility:
    origin = source["name"]
    to = target["name"]
    if to == "any":
        return {"level": "same"}
    if origin == "any":
        return {"level": "conversion", "fallible": True}
    if origin == to:
        if origin in ("integer", "float"):
            # A number without a size (JSON, TypeScript, Python) fits any size the other side chose
            source_bits, target_bits = source.get("bits"), target.get("bits")
            if source_bits is None or target_bits is None or source_bits == target_bits:
                return {"level": "same"}
            return {"level": "widening"} if source_bits < target_bits else {"level": "conversion", "lossy": True}
        return {"level": "same"}
    if origin in _NUMBERS and to in _NUMBERS:
        if origin == "integer":
            return {"level": "widening"}
        # float ↔ decimal changes the representation; float/decimal → integer drops the decimals
        return {"level": "conversion", "lossy": True} if to == "integer" else {"level": "conversion"}
    if to == "string":
        return {"level": "transform"} if origin == "binary" else {"level": "conversion"}
    if origin == "string":
        if to in _PARSED_FROM_TEXT:
            return {"level": "conversion", "fallible": True}
        # Booleans ("yes", "Y", "ACTIVE": only the user knows which texts mean true) and binary data
        return {"level": "transform"}
    if origin == "date" and to == "datetime":
        return {"level": "widening"}
    if origin == "datetime" and to in ("date", "time"):
        return {"level": "conversion", "lossy": True}
    if origin == "boolean" and to == "integer":
        return {"level": "conversion"}
    if origin == "integer" and to == "boolean":
        return {"level": "transform"}
    # Epoch seconds or milliseconds: the unit has to be chosen (number in TypeScript is a float)
    if origin in ("integer", "float") and to in ("datetime", "date"):
        return {"level": "transform"}
    if origin in ("datetime", "date") and to in ("integer", "float"):
        return {"level": "transform"}
    return {"level": "incompatible"}


def _is_primitive(type_ref: TypeRef, *names: str) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in names


def compatibility(source: TypeRef, target: TypeRef) -> Compatibility:
    """Compatibility of assigning a value of source type to a field of target type, ignoring nullability."""
    if _is_primitive(target, "any"):
        return {"level": "same"}
    sk, tk = source["kind"], target["kind"]

    if sk == "array" or tk == "array":
        if sk == "array" and tk == "array":
            items = compatibility(source["items"], target["items"])
            return {"level": "incompatible" if items["level"] == "incompatible" else "collection", "items": items}
        return {"level": "incompatible"}

    if sk == "map" or tk == "map":
        if sk == "map" and tk == "map":
            items = compatibility(source["value"], target["value"])
            return {"level": "incompatible" if items["level"] == "incompatible" else "collection", "items": items}
        return {"level": "incompatible"}

    if sk == "model" or tk == "model":
        if sk == "model" and tk == "model":
            return {"level": "same"} if source["name"] == target["name"] else {"level": "nested"}
        if _is_primitive(source, "any"):
            return {"level": "conversion", "fallible": True}
        return {"level": "incompatible"}

    if sk == "enum" or tk == "enum":
        if sk == "enum" and tk == "enum":
            # Different enums need their values related; the validation checks they all are
            return {"level": "same"} if source["name"] == target["name"] else {"level": "transform"}
        other = target if sk == "enum" else source
        if _is_primitive(other, "string", "integer"):
            # Enum → text is safe; text → enum fails for unknown values
            return {"level": "conversion"} if sk == "enum" else {"level": "conversion", "fallible": True}
        if _is_primitive(other, "any"):
            return {"level": "conversion", "fallible": True}
        return {"level": "incompatible"}

    if sk == "unknown" or tk == "unknown":
        if sk == "unknown" and tk == "unknown" and source["name"] == target["name"]:
            return {"level": "same"}
        # Types declared elsewhere: nothing can be checked, the user decides
        return {"level": "transform"}

    return _primitive_compatibility(source, target)


def assignable(result: Compatibility) -> bool:
    """Whether a value of this compatibility can be assigned without a user-chosen transformation."""
    if result["level"] == "collection":
        return assignable(result["items"]) if "items" in result else False
    return result["level"] in ("same", "widening", "conversion", "nested")
