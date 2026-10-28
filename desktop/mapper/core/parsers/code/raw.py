"""What a declaration parser reads, before types are resolved. Mirrors web/src/core/parsers/code/raw.ts.
Parsers only deal with syntax; the language's TypeTable turns type names into the common types
(docs/adding-a-language.md).

A raw type is {"name", "args", "nullable"?}: arrays are "[]" with one argument and inline maps "{}" with key
and value; unions are "|" and intersections "&". Generic types keep their name and arguments
(List<String> → name List, args [String]). Raw fields, models and enums are dictionaries with the keys of the
web version's RawField, RawModel and RawEnum; declarations are {"models", "enums", "aliases"?, "warnings"}.
"""

import re
from dataclasses import dataclass, field

from ...js import number, trim
from ...model.schema import empty_schema, primitive

RawType = dict


def raw(name: str, args: list | None = None, nullable: bool = False) -> RawType:
    result: RawType = {"name": name, "args": args or []}
    if nullable:
        result["nullable"] = True
    return result


@dataclass(frozen=True)
class TypeTable:
    """Names of a language's types. Keys are matched after dropping any namespace (java.util.List → List)."""

    primitives: dict
    # Primitives that can also hold null (Java Integer)
    nullable_primitives: dict = field(default_factory=dict)
    # Generic collections whose first argument is the element type
    lists: tuple = ()
    # Generic maps: key and value types
    maps: tuple = ()
    # Wrappers meaning "may be null or missing": Optional<T>, Option<T>, Nullable<T>
    optionals: tuple = ()
    # Wrappers that do not change the type (Mapped[T], Box<T>, Readonly<T>)
    transparent: tuple = ()
    # Names that mean "no value", allowed in unions (null, None, undefined, nil)
    null_names: tuple = ()
    case_insensitive: bool = False


_SEPARATORS = re.compile(r"\.|::|\\")


def _simple_name(name: str) -> str:
    return _SEPARATORS.split(name)[-1]


class TypeResolver:
    def __init__(self, table: TypeTable, declarations: dict):
        self.table = table
        self.models = {model["name"] for model in declarations["models"]}
        self.enums = {item["name"] for item in declarations["enums"]}
        self.aliases: dict = declarations.get("aliases") or {}
        # Insertion-ordered set of names that could not be resolved
        self.unknown: dict[str, None] = {}

    def _lookup(self, record: dict, name: str):
        if not record:
            return None
        if name in record:
            return record[name]
        simple = _simple_name(name)
        if simple in record:
            return record[simple]
        if self.table.case_insensitive:
            lower = simple.lower()
            key = next((item for item in record if item.lower() == lower), None)
            if key is not None:
                return record[key]
        return None

    def _matches(self, names: tuple, name: str) -> bool:
        if not names:
            return False
        simple = _simple_name(name)
        return (
            name in names
            or simple in names
            or (self.table.case_insensitive and any(item.lower() == simple.lower() for item in names))
        )

    def resolve(self, raw_type: RawType | None, depth: int = 0) -> tuple[dict, bool]:
        """The common type and whether the syntax made it nullable."""
        if not raw_type or depth > 32:
            return primitive("any"), False
        type_ref, nullable = self._resolve_inner(raw_type, depth)
        return type_ref, nullable or bool(raw_type.get("nullable"))

    def _list(self, args: list, depth: int) -> tuple[dict, bool]:
        items, items_nullable = self.resolve(args[0] if args else None, depth + 1)
        type_ref = {"kind": "array", "items": items}
        if items_nullable:
            type_ref["itemsNullable"] = True
        return type_ref, False

    def _resolve_inner(self, raw_type: RawType, depth: int) -> tuple[dict, bool]:
        name, args = raw_type["name"], raw_type["args"]
        table = self.table
        if name == "[]":
            return self._list(args, depth)
        if name == "{}":
            key = self.resolve(args[0] if args else None, depth + 1)[0]
            value = self.resolve(args[1] if len(args) > 1 else None, depth + 1)[0]
            return {"kind": "map", "key": key, "value": value}, False
        if name == "|":
            options = [option for option in args if option["name"] not in table.null_names]
            nullable = len(options) < len(args)
            if len(options) == 1:
                inner, inner_nullable = self.resolve(options[0], depth + 1)
                return inner, inner_nullable or nullable
            return primitive("any"), nullable
        if name == "&":
            # An intersection (Base & { extra: string }): its first named part is the best description
            parts = [self.resolve(part, depth + 1) for part in args]
            return next(
                (part for part in parts if part[0]["kind"] == "model"), parts[0] if parts else (primitive("any"), False)
            )
        # A type that is only null (notes: None, notes: null): a value of unknown shape that is always missing
        if not args and name in table.null_names:
            return primitive("any"), True
        if self._matches(table.optionals, name) and len(args) == 1:
            return self.resolve(args[0], depth + 1)[0], True
        if self._matches(table.transparent, name) and len(args) == 1:
            return self.resolve(args[0], depth + 1)
        if self._matches(table.lists, name):
            return self._list(args, depth)
        if self._matches(table.maps, name):
            key = self.resolve(args[0], depth + 1)[0] if len(args) >= 2 else primitive("string")
            value = self.resolve(args[1] if len(args) >= 2 else None, depth + 1)[0]
            return {"kind": "map", "key": key, "value": value}, False
        nullable_primitive = self._lookup(table.nullable_primitives, name)
        if nullable_primitive:
            return dict(nullable_primitive), True
        primitive_type = self._lookup(table.primitives, name)
        if primitive_type:
            return dict(primitive_type), False
        simple = _simple_name(name)
        if name in self.models or simple in self.models:
            return {"kind": "model", "name": name if name in self.models else simple}, False
        if name in self.enums or simple in self.enums:
            return {"kind": "enum", "name": name if name in self.enums else simple}, False
        alias = self.aliases.get(name) or self.aliases.get(simple)
        if alias and depth < 16:
            return self.resolve(alias, depth + 1)
        self.unknown[name] = None
        return {"kind": "unknown", "name": simple}, False


def type_text(raw_type: RawType | None) -> str:
    """Writes a raw type back as text (List<String>), for display when the parser kept no original text."""
    if not raw_type:
        return ""
    name, args = raw_type["name"], raw_type["args"]
    if name == "[]":
        text = f"{type_text(args[0] if args else None)}[]"
    elif name == "{}":
        text = f"{{{type_text(args[0] if args else None)}: {type_text(args[1] if len(args) > 1 else None)}}}"
    elif name == "|":
        text = " | ".join(type_text(arg) for arg in args)
    else:
        text = f"{name}<{', '.join(type_text(arg) for arg in args)}>" if args else name
    return f"{text}?" if raw_type.get("nullable") else text


_FIELD_KEYS = ("defaultValue", "serializedName", "aliases", "description", "annotations", "generated", "metadata")
_MODEL_KEYS = (
    "namespace",
    "generics",
    "extends",
    "framework",
    "construction",
    "description",
    "annotations",
    "metadata",
)


def _copy_keys(target: dict, source: dict, keys: tuple) -> None:
    """Copies the keys that have a value. None is undefined, except for defaultValue, where it is null and
    MISSING is undefined."""
    for key in keys:
        if key not in source:
            continue
        value = source[key]
        if value is MISSING or (value is None and key != "defaultValue"):
            continue
        if not (isinstance(value, list) and not value):
            target[key] = value


def build_schema(declarations: dict, table: TypeTable, format_id: str, language: str) -> dict:
    """Resolves the types of the declarations and builds the schema: {"schema", "warnings"}."""
    resolver = TypeResolver(table, declarations)
    warnings = list(declarations["warnings"])
    generics = {model["name"]: set(model.get("generics") or []) for model in declarations["models"]}
    frameworks: dict[str, None] = {}

    models = []
    for raw_model in declarations["models"]:
        if raw_model.get("framework"):
            frameworks[raw_model["framework"]] = None
        seen: set[str] = set()
        fields = []
        for raw_field in raw_model["fields"]:
            if raw_field["name"] in seen:
                warnings.append(
                    {"code": "duplicateField", "params": {"model": raw_model["name"], "field": raw_field["name"]}}
                )
                continue
            seen.add(raw_field["name"])
            own = generics[raw_model["name"]]
            raw_type = raw_field.get("type")
            # A generic parameter of the model (T data) is a value of unknown shape
            if raw_type and raw_type["name"] in own and not raw_type["args"]:
                type_ref, nullable = {"kind": "unknown", "name": raw_type["name"]}, bool(raw_type.get("nullable"))
            else:
                type_ref, nullable = resolver.resolve(raw_type)
            field_def = {
                "name": raw_field["name"],
                "type": type_ref,
                "nullable": nullable or raw_field.get("nullable") is True,
                "optional": raw_field.get("optional") is True,
            }
            original = raw_field.get("typeText") or (type_text(raw_type) if raw_type else None)
            if original:
                field_def["originalType"] = original
            _copy_keys(field_def, raw_field, _FIELD_KEYS)
            fields.append(field_def)
        model = {"name": raw_model["name"], "kind": raw_model["kind"], "fields": fields}
        _copy_keys(model, raw_model, _MODEL_KEYS)
        models.append(model)

    # Keep only parents that are part of the input: others (BaseModel, Object) carry no known fields
    known = {model["name"] for model in models}
    for model in models:
        if "extends" in model:
            model["extends"] = [parent for parent in model["extends"] if parent in known]
            if not model["extends"]:
                del model["extends"]

    enums = []
    for raw_enum in declarations["enums"]:
        item = {"name": raw_enum["name"], "values": raw_enum["values"]}
        for key in ("kind", "namespace", "description"):
            if raw_enum.get(key):
                item[key] = raw_enum[key]
        enums.append(item)

    # Duplicate declarations (two classes with the same name): the first one wins
    unique = []
    for model in models:
        if any(item["name"] == model["name"] for item in unique):
            warnings.append({"code": "duplicateModel", "params": {"model": model["name"]}})
        else:
            unique.append(model)

    for name in resolver.unknown:
        warnings.append({"code": "unknownType", "params": {"type": name}})
    origin = {"format": format_id, "language": language}
    if len(frameworks) == 1:
        origin["framework"] = next(iter(frameworks))
    schema = empty_schema(origin)
    schema["models"] = unique
    schema["enums"] = enums
    return {"schema": schema, "warnings": warnings}


_NUMBER = re.compile(r"-?[0-9]+(\.[0-9]+)?")
_QUOTED = re.compile(r"([\"'])(.*)\1", re.DOTALL)


def parse_literal(text: str):
    """Parses a literal written in code ("x", 42, true, None) for default values. Expressions return the
    MISSING marker: the web version's undefined."""
    value = trim(text)
    if _NUMBER.fullmatch(value):
        return number(value)
    if value in ("true", "True", "TRUE"):
        return True
    if value in ("false", "False", "FALSE"):
        return False
    if value in ("null", "None", "nil", "NULL", "undefined"):
        return None
    quoted = _QUOTED.fullmatch(value)
    if quoted:
        return quoted.group(2)
    return MISSING


class _Missing:
    """undefined: no value at all, unlike None, which is null."""

    def __repr__(self) -> str:
        return "MISSING"

    def __bool__(self) -> bool:
        return False


MISSING = _Missing()


def parse_declarations(text: str, lexer, read, table: TypeTable, format_id: str, language: str, enums_count=True):
    """The common steps of a declaration parser: tokenize, read the declarations with read(text, tokens) and
    build the schema. Without models (or enums, when they count) there is nothing to map."""
    from ..types import failure, position_at
    from .lexer import LexError, tokenize

    if trim(text) == "":
        return failure("empty")
    try:
        tokens = tokenize(text, lexer)
    except LexError as error:
        return failure(error.code, position_at(text, error.index))
    declarations = read(text, tokens)
    if not declarations["models"] and not (enums_count and declarations["enums"]):
        return failure("noModels")
    built = build_schema(declarations, table, format_id, language)
    return {"ok": True, "schema": built["schema"], "warnings": built["warnings"]}
