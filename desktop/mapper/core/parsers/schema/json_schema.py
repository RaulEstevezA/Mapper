"""Converts JSON Schema (draft 4 to 2020-12) and the schema objects of OpenAPI and Swagger into models.
Mirrors web/src/core/parsers/schema/jsonSchema.ts. $refs to definitions become references to the model of
that definition."""

import re

from ...js import is_number, js_string, parse_json_value, to_js_value, trim, trim_start
from ...model.naming import to_pascal_case, unique_name
from ...model.schema import empty_schema, primitive
from ..data.json_text import parse_json
from ..data.yaml import read_yaml
from ..types import InputParser, failure, root_name


def _is_object(value) -> bool:
    return isinstance(value, dict)


def read_structured(text: str) -> dict:
    """Reads JSON, and YAML when it is not JSON: schemas are written in both. {"ok", "value"} or
    {"ok": False, "outcome"}."""
    if trim(text) == "":
        return {"ok": False, "outcome": failure("empty")}
    start = trim_start(text)[:1]
    if start in ("{", "[") and start:
        parsed = parse_json(text)
        if not parsed["ok"]:
            error = parsed["error"]
            params = {"detail": f"json.{error['code']}"}
            for name in ("found", "expected", "key"):
                if name in error:
                    params[name] = error[name]
            return {
                "ok": False,
                "outcome": failure("syntax", {"line": error["line"], "column": error["column"]}, params),
            }
        return {"ok": True, "value": parse_json_value(text[1:] if text.startswith("﻿") else text)}
    read = read_yaml(text)
    if read["ok"]:
        read["value"] = to_js_value(read["value"])
    return read


FORMAT_TYPES = {
    "date-time": primitive("datetime"),
    "date": primitive("date"),
    "time": primitive("time"),
    "duration": primitive("duration"),
    "uuid": primitive("uuid"),
    "byte": primitive("binary"),
    "binary": primitive("binary"),
    "int32": primitive("integer", 32),
    "int64": primitive("integer", 64),
    "float": primitive("float", 32),
    "double": primitive("float", 64),
    "decimal": primitive("decimal"),
}


class _Context:
    def __init__(self):
        # Definitions by the path a $ref uses (#/$defs/Address, #/components/schemas/Address)
        self.definitions: dict[str, tuple[str, dict]] = {}
        self.models: list[dict] = []
        self.enums: list[dict] = []
        self.used_names: set[str] = set()
        # Definition paths already converted (or being converted)
        self.converted: set[str] = set()
        self.warnings: list[dict] = []


def _types_of(schema: dict) -> tuple[list[str], bool]:
    """type: ["string", "null"], nullable: true (OpenAPI 3.0), x-nullable (Swagger) or oneOf with null."""
    raw = schema.get("type")
    types = (
        [item for item in raw if isinstance(item, str)]
        if isinstance(raw, list)
        else [raw]
        if isinstance(raw, str)
        else []
    )
    nullable = "null" in types or schema.get("nullable") is True or schema.get("x-nullable") is True
    return [item for item in types if item != "null"], nullable


def _ref_target(ref: str, context: _Context) -> str | None:
    definition = context.definitions.get(ref)
    if not definition:
        return None
    if ref not in context.converted:
        context.converted.add(ref)
        _convert_type(definition[1], definition[0], context, True)
    return definition[0]


def _format_type(schema: dict) -> dict | None:
    value = schema.get("format")
    return FORMAT_TYPES.get(value) if isinstance(value, str) else None


def _convert_type(schema: dict, name_hint: str, context: _Context, named: bool = False) -> tuple[dict, bool]:
    """Type of a schema and whether it is nullable. named is set for definitions: an object or enum is created
    with that exact name."""
    ref = schema.get("$ref")
    if isinstance(ref, str):
        target = _ref_target(ref, context)
        if target:
            definition = context.definitions[ref]
            if any(item["name"] == target for item in context.enums):
                return {"kind": "enum", "name": target}, False
            if any(item["name"] == target for item in context.models):
                return {"kind": "model", "name": target}, False
            # An alias definition (Id: {type: string}): use what it stands for
            return _convert_type(definition[1], name_hint, context)
        context.warnings.append({"code": "unknownType", "params": {"type": ref, "field": name_hint}})
        return primitive("any"), False

    types, nullable = _types_of(schema)

    for key in ("oneOf", "anyOf"):
        options = schema.get(key)
        if isinstance(options, list):
            non_null = [option for option in options if _is_object(option) and option.get("type") != "null"]
            has_null = len(non_null) < len(options)
            if len(non_null) == 1:
                inner, inner_nullable = _convert_type(non_null[0], name_hint, context, named)
                return inner, inner_nullable or has_null or nullable
            if len(non_null) > 1:
                return primitive("any"), has_null or nullable

    values_raw = schema.get("enum")
    if isinstance(values_raw, list):
        values = [value for value in values_raw if value is not None]
        enum_nullable = len(values) < len(values_raw) or nullable
        if all(isinstance(value, str) or is_number(value) for value in values):
            name = name_hint if named else unique_name(to_pascal_case(name_hint) or "Enum", context.used_names)
            if named:
                context.used_names.add(name)
            enum_def: dict = {
                "name": name,
                "kind": "literals",
                "values": [
                    {"name": js_string(value), **({"value": value} if is_number(value) else {})} for value in values
                ],
            }
            if isinstance(schema.get("description"), str):
                enum_def["description"] = schema["description"]
            context.enums.append(enum_def)
            return {"kind": "enum", "name": name}, enum_nullable

    if types:
        type_name = types[0]
    elif _is_object(schema.get("properties")) or isinstance(schema.get("allOf"), list):
        type_name = "object"
    elif _is_object(schema.get("items")):
        type_name = "array"
    else:
        type_name = None
    if type_name == "array":
        if _is_object(schema.get("items")):
            items, items_nullable = _convert_type(schema["items"], f"{name_hint}Item", context)
        else:
            items, items_nullable = primitive("any"), False
        array = {"kind": "array", "items": items}
        if items_nullable:
            array["itemsNullable"] = True
        return array, nullable
    if type_name == "object":
        has_properties = _is_object(schema.get("properties")) or isinstance(schema.get("allOf"), list)
        if not has_properties:
            additional = schema.get("additionalProperties")
            value = (
                _convert_type(additional, f"{name_hint}Value", context)[0]
                if _is_object(additional)
                else primitive("any")
            )
            return {"kind": "map", "key": primitive("string"), "value": value}, nullable
        title = schema.get("title")
        name = (
            name_hint
            if named
            else unique_name(
                to_pascal_case(title if isinstance(title, str) else name_hint) or "Model", context.used_names
            )
        )
        if named:
            context.used_names.add(name)
        _build_model(name, schema, context)
        return {"kind": "model", "name": name}, nullable
    if type_name == "string":
        found = _format_type(schema)
        usable = found and found["kind"] == "primitive" and found["name"] not in ("integer", "float")
        return dict(found) if usable else primitive("string"), nullable
    if type_name == "integer":
        found = _format_type(schema)
        return dict(found) if found and found["name"] == "integer" else primitive("integer"), nullable
    if type_name == "number":
        found = _format_type(schema)
        return dict(found) if found and found["name"] in ("float", "decimal") else primitive("float"), nullable
    if type_name == "boolean":
        return primitive("boolean"), nullable
    return primitive("any"), nullable


def _literal(value):
    """A default value, or the marker that there is none."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return _NO_DEFAULT


_NO_DEFAULT = object()


def _build_model(name: str, schema: dict, context: _Context) -> None:
    model: dict = {"name": name, "kind": "object", "fields": []}
    if isinstance(schema.get("description"), str):
        model["description"] = schema["description"]
    context.models.append(model)
    parts = [part for part in schema["allOf"] if _is_object(part)] if isinstance(schema.get("allOf"), list) else []
    for part in [*parts, schema]:
        if part is not schema and isinstance(part.get("$ref"), str):
            parent = _ref_target(part["$ref"], context)
            if parent and any(item["name"] == parent for item in context.models):
                model["extends"] = [*model.get("extends", []), parent]
                continue
        required_raw = part.get("required")
        required = {item for item in required_raw if isinstance(item, str)} if isinstance(required_raw, list) else set()
        properties = part.get("properties") if _is_object(part.get("properties")) else {}
        for key, prop in properties.items():
            if not _is_object(prop):
                continue
            if any(field["name"] == key for field in model["fields"]):
                context.warnings.append({"code": "duplicateField", "params": {"model": name, "field": key}})
                continue
            type_ref, nullable = _convert_type(prop, key, context)
            field: dict = {"name": key, "type": type_ref, "nullable": nullable, "optional": key not in required}
            default = _literal(prop["default"]) if "default" in prop else _NO_DEFAULT
            if default is not _NO_DEFAULT:
                field["defaultValue"] = default
            if isinstance(prop.get("description"), str):
                field["description"] = prop["description"]
            if prop.get("readOnly") is True:
                field["generated"] = True
            if isinstance(prop.get("format"), str):
                kind = prop.get("type")
                field["originalType"] = f"{'' if kind is None else js_string(kind)}({prop['format']})"
            model["fields"].append(field)


def convert_schemas(definitions: list[tuple[str, object]], root: dict | None, root_model_name: str, format_id: str):
    """Models of a schema document: {"schema", "warnings"}. definitions lists where the named schemas are, by
    the prefix their $refs use; root is the top-level schema, when the document itself is one."""
    context = _Context()
    for prefix, schemas in definitions:
        if not _is_object(schemas):
            continue
        for key, schema in schemas.items():
            if _is_object(schema):
                context.definitions[f"{prefix}{key}"] = (to_pascal_case(key) or key, schema)
    # Names of definitions are reserved first, so inline models never take them
    for name, _ in context.definitions.values():
        context.used_names.add(name)

    root_model = None
    if root and (
        _is_object(root.get("properties")) or isinstance(root.get("allOf"), list) or root.get("type") == "object"
    ):
        title = root.get("title")
        name = (to_pascal_case(title) or root_model_name) if isinstance(title, str) else root_model_name
        final_name = unique_name(name, context.used_names)
        converted, _ = _convert_type(root, final_name, context, True)
        if converted["kind"] == "model":
            root_model = converted["name"]
    for path, (name, schema) in list(context.definitions.items()):
        if path not in context.converted:
            context.converted.add(path)
            _convert_type(schema, name, context, True)
    result = empty_schema({"format": format_id})
    result["models"] = context.models
    result["enums"] = context.enums
    if root_model:
        result["root"] = root_model
    return {"schema": result, "warnings": context.warnings}


_SCHEMA_URL = re.compile(r"[\"']?\$schema[\"']?\s*:\s*[\"']?https?://json-schema\.org")
_DEFINITIONS = re.compile(r"[\"']?(\$defs|definitions)[\"']?\s*:")
_PROPERTIES = re.compile(r"[\"']?properties[\"']?\s*:")
_OBJECT_TYPE = re.compile(r"\"type\"\s*:\s*\"object\"")
_PROPERTIES_OBJECT = re.compile(r"\"properties\"\s*:\s*\{")


def _detect(text: str) -> float:
    head = text[:4000]
    if _SCHEMA_URL.search(head):
        return 0.98
    if _DEFINITIONS.search(head) and _PROPERTIES.search(head):
        return 0.85
    if _OBJECT_TYPE.search(head) and _PROPERTIES_OBJECT.search(head):
        return 0.85
    return 0


def _parse(text: str, options: dict | None = None) -> dict:
    read = read_structured(text)
    if not read["ok"]:
        return read["outcome"]
    document = read["value"]
    if not _is_object(document):
        return failure("noModels")
    converted = convert_schemas(
        [("#/$defs/", document.get("$defs")), ("#/definitions/", document.get("definitions"))],
        document,
        root_name(options, "Root"),
        "jsonschema",
    )
    if not converted["schema"]["models"]:
        return failure("noModels")
    return {"ok": True, "schema": converted["schema"], "warnings": converted["warnings"]}


json_schema_parser = InputParser("jsonschema", "schema", "JSON Schema", (".schema.json",), "json", _detect, _parse)
