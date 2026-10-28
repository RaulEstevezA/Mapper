"""Names of fields and types in generated code. Mirrors web/src/core/generate/naming.ts."""

import re
import unicodedata
from dataclasses import dataclass

from ..model.naming import convert_case, to_pascal_case

# Formats whose names are keys of a document (JSON, YAML…), not names written in code
_DATA_FORMATS = {"json", "yaml", "xml", "csv", "jsonschema", "openapi", "modelschema", "graphql", "protobuf", "prisma"}


@dataclass(frozen=True)
class NamingRules:
    language: str
    convention: str
    reserved: frozenset
    # How a reserved word is made usable (class_, `class`, @class, r#type)
    escape: object
    # Plain objects keep document keys as they are (TypeScript, JavaScript, Python dicts)
    raw_objects: bool = False
    # Go writes initialisms in capitals: ID, URL
    initialisms: bool = False


_INITIALISMS = (
    "Id",
    "Url",
    "Uri",
    "Api",
    "Http",
    "Https",
    "Json",
    "Xml",
    "Sql",
    "Uuid",
    "Html",
    "Ip",
    "Tcp",
    "Udp",
    "Css",
    "Dns",
    "Cpu",
    "Ui",
)
_INITIALISM = re.compile(rf"({'|'.join(_INITIALISMS)})(?=[A-Z0-9]|$)")


def _go_initialisms(name: str) -> str:
    # UserId → UserID, ApiUrl → APIURL: each capitalized initialism ends where the next word starts
    return _INITIALISM.sub(lambda match: match.group(0).upper(), name)


def is_valid_identifier(name: str) -> bool:
    if not name:
        return False
    first = name[0]
    if not (first == "_" or unicodedata.category(first)[0] == "L"):
        return False
    return all(char == "_" or unicodedata.category(char)[0] in "LN" for char in name[1:])


def keeps_names(schema: dict, rules: NamingRules, mode: str) -> bool:
    """Whether names of a schema are used as they are in this language."""
    if mode == "keep":
        return True
    if mode == "convention":
        return False
    origin = schema.get("origin")
    if origin and origin.get("language") == rules.language:
        return True
    # A JavaScript program reads JSON as objects with the same keys
    if rules.raw_objects and origin and origin.get("format") in _DATA_FORMATS:
        return True
    language = origin.get("language") if origin else None
    if (
        rules.raw_objects
        and language in ("typescript", "javascript")
        and rules.language in ("typescript", "javascript")
    ):
        return True
    return False


def conventional_name(name: str, rules: NamingRules) -> str:
    """A name in the language's convention, usable as an identifier."""
    result = convert_case(name, rules.convention) or "field"
    if rules.initialisms:
        result = _go_initialisms(result)
    if unicodedata.category(result[0])[0] == "N":
        result = f"_{result}"
    return rules.escape(result) if result in rules.reserved else result


def field_name(field_def: dict, schema: dict, rules: NamingRules, mode: str) -> str:
    """Name of a field in the generated code."""
    name = field_def["name"]
    if keeps_names(schema, rules, mode) and (is_valid_identifier(name) or rules.raw_objects):
        return rules.escape(name) if name in rules.reserved and not rules.raw_objects else name
    return conventional_name(name, rules)


def type_name(name: str) -> str:
    """A type name usable in code (model names are kept; data formats may give odd ones)."""
    return name if is_valid_identifier(name) else to_pascal_case(name) or "Model"
