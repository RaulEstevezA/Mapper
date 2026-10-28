"""Writes a new target model from the source one. Mirrors web/src/core/generate/models.ts: the same fields in the
conventions of the chosen language, as text the user edits in the target editor. It is a starting point, not a
mapping: once written, the target is read back like any other input."""

import json
import re

from ..js import coalesce, js_string
from ..model.naming import convert_case, to_pascal_case, to_screaming_snake_case
from ..model.schema import all_fields, find_enum, find_model, model_of

DRAFT_FORMATS = ("typescript", "python", "kotlin", "java", "csharp", "jsonschema")

# Suffixes that describe the source's role, not what it holds: UserDto, OrderResponse, AddressApi
_ROLE_SUFFIX = re.compile(r"(Dto|DTO|Response|Request|Api|API|Payload|Resource|Entity|Record|Model|Data|Json|Schema)$")


def draft_name(name: str) -> str:
    """Name of the new model: the source name without its role suffix (UserDto → User). A generic name (Source,
    read from a JSON document) becomes Target."""
    if name in ("Source", "Root"):
        return "Target"
    stripped = _ROLE_SUFFIX.sub("", name, count=1)
    return to_pascal_case(name if stripped == "" else stripped) or "Target"


def _enum_of(type_ref: dict) -> str | None:
    if type_ref["kind"] == "enum":
        return type_ref["name"]
    if type_ref["kind"] == "array":
        return _enum_of(type_ref["items"])
    if type_ref["kind"] == "map":
        return _enum_of(type_ref["value"])
    return None


def _collect(schema: dict, root: str) -> dict:
    """The root model and every model and enum it uses, nested ones first, with their new names."""
    models: list[dict] = []
    enums: list[dict] = []
    names: dict[str, str] = {}
    used: set[str] = set()

    def rename(name: str) -> None:
        candidate = draft_name(name)
        n = 2
        while candidate in used:
            candidate = f"{draft_name(name)}{n}"
            n += 1
        used.add(candidate)
        names[name] = candidate

    def visit(name: str) -> None:
        if name in names:
            return
        model = find_model(schema, name)
        if not model:
            return
        rename(name)
        for field in all_fields(schema, model):
            enum_name = _enum_of(field["type"])
            if enum_name and enum_name not in names:
                enum_def = find_enum(schema, enum_name)
                if enum_def:
                    rename(enum_name)
                    enums.append(enum_def)
            nested = model_of(field["type"])
            if nested:
                visit(nested)
        models.append({**model, "fields": all_fields(schema, model)})

    visit(root)
    return {"models": models, "enums": enums, "names": names}


def _missing_allowed(field: dict) -> bool:
    return field["nullable"] or field["optional"]


def _ref(type_ref: dict, names: dict) -> str:
    return names.get(type_ref["name"]) or draft_name(type_ref["name"])


def _jsdoc(text, indent: str = "") -> str:
    """/** text */ above a declaration, indented; nothing without text."""
    return f"{indent}/** {text} */\n" if text else ""


def _enum_value(value: dict) -> str:
    return json.dumps(js_string(coalesce(value.get("value"), value["name"])), ensure_ascii=False)


# TypeScript


def _ts_type(type_ref: dict, names: dict) -> str:
    kind = type_ref["kind"]
    if kind == "primitive":
        name = type_ref["name"]
        if name in ("integer", "float", "decimal"):
            return "number"
        if name == "boolean":
            return "boolean"
        if name in ("date", "datetime"):
            return "Date"
        return "unknown" if name == "any" else "string"
    if kind == "array":
        return f"{_ts_type(type_ref['items'], names)}[]"
    if kind == "map":
        return f"Record<string, {_ts_type(type_ref['value'], names)}>"
    if kind in ("model", "enum"):
        return _ref(type_ref, names)
    return "unknown"


def _ts_model(name: str, model: dict, fields: list, names: dict) -> str:
    lines = [
        f"{_jsdoc(field.get('description'), '  ')}  {field_name}{'?' if field['optional'] else ''}: "
        f"{_ts_type(field['type'], names)}{' | null' if field['nullable'] else ''}"
        for field_name, field in fields
    ]
    return f"{_jsdoc(model.get('description'))}export interface {name} {{\n" + "\n".join(lines) + "\n}"


def _ts_enum(name: str, enum_def: dict) -> str:
    values = [f"  {to_pascal_case(value['name']) or 'Value'} = {_enum_value(value)}," for value in enum_def["values"]]
    return f"export enum {name} {{\n" + "\n".join(values) + "\n}"


# Python

_PYTHON_TYPES = {
    "string": "str",
    "integer": "int",
    "float": "float",
    "decimal": "Decimal",
    "boolean": "bool",
    "date": "date",
    "datetime": "datetime",
    "time": "time",
    "duration": "timedelta",
    "uuid": "UUID",
    "binary": "bytes",
    "any": "Any",
}


def _python_type(type_ref: dict, names: dict) -> str:
    kind = type_ref["kind"]
    if kind == "primitive":
        return _PYTHON_TYPES.get(type_ref["name"], "undefined")
    if kind == "array":
        return f"list[{_python_type(type_ref['items'], names)}]"
    if kind == "map":
        return f"dict[str, {_python_type(type_ref['value'], names)}]"
    if kind in ("model", "enum"):
        return _ref(type_ref, names)
    return "Any"


def _python_model(name: str, model: dict, fields: list, names: dict) -> str:
    # Fields with a default go last: dataclasses do not allow a required field after an optional one
    ordered = [item for item in fields if not _missing_allowed(item[1])] + [
        item for item in fields if _missing_allowed(item[1])
    ]
    lines = [
        f"    {field_name}: {_python_type(field['type'], names)}{' | None = None' if _missing_allowed(field) else ''}"
        for field_name, field in ordered
    ]
    description = f'    """{model["description"]}"""\n\n' if model.get("description") else ""
    return f"@dataclass\nclass {name}:\n{description}" + ("\n".join(lines) if lines else "    pass")


def _python_enum(name: str, enum_def: dict) -> str:
    values = [
        f"    {to_screaming_snake_case(value['name']) or 'VALUE'} = {_enum_value(value)}"
        for value in enum_def["values"]
    ]
    return f"class {name}(str, Enum):\n" + "\n".join(values)


def _python_header(body: str) -> str:
    imports = ["from dataclasses import dataclass"]
    datetime = [name for name in ("date", "datetime", "time", "timedelta") if re.search(rf": (.*\W)?{name}\b", body)]
    if datetime:
        imports.append(f"from datetime import {', '.join(datetime)}")
    if re.search(r"\bDecimal\b", body):
        imports.append("from decimal import Decimal")
    if "(str, Enum)" in body:
        imports.append("from enum import Enum")
    if re.search(r"\bAny\b", body):
        imports.append("from typing import Any")
    if re.search(r"\bUUID\b", body):
        imports.append("from uuid import UUID")
    return "\n".join(imports) + "\n\n\n" + body


# Kotlin

_KOTLIN_TYPES = {
    "string": "String",
    "float": "Double",
    "decimal": "BigDecimal",
    "boolean": "Boolean",
    "date": "LocalDate",
    "datetime": "Instant",
    "time": "LocalTime",
    "duration": "Duration",
    "uuid": "UUID",
    "binary": "ByteArray",
    "any": "Any",
}


def _small_integer(type_ref: dict) -> bool:
    return type_ref.get("bits") in (32, 16, 8)


def _kotlin_type(type_ref: dict, names: dict) -> str:
    kind = type_ref["kind"]
    if kind == "primitive":
        if type_ref["name"] == "integer":
            return "Int" if _small_integer(type_ref) else "Long"
        return _KOTLIN_TYPES.get(type_ref["name"], "Any")
    if kind == "array":
        return f"List<{_kotlin_type(type_ref['items'], names)}>"
    if kind == "map":
        return f"Map<String, {_kotlin_type(type_ref['value'], names)}>"
    if kind in ("model", "enum"):
        return _ref(type_ref, names)
    return "Any"


def _kotlin_model(name: str, model: dict, fields: list, names: dict) -> str:
    lines = [
        f"    val {field_name}: {_kotlin_type(field['type'], names)}{'? = null' if _missing_allowed(field) else ''},"
        for field_name, field in fields
    ]
    return f"{_jsdoc(model.get('description'))}data class {name}(\n" + "\n".join(lines) + "\n)"


def _kotlin_enum(name: str, enum_def: dict) -> str:
    values = ", ".join(to_screaming_snake_case(value["name"]) or "VALUE" for value in enum_def["values"])
    return f"enum class {name} {{ {values} }}"


def _imports_header(body: str, imports: list, terminator: str) -> str:
    found = [path for name, path in imports if re.search(rf"\b{name}\b", body)]
    if not found:
        return body
    return "\n".join(f"import {path}{terminator}" for path in found) + "\n\n" + body


def _kotlin_header(body: str) -> str:
    imports = [
        ("BigDecimal", "java.math.BigDecimal"),
        ("Duration", "java.time.Duration"),
        ("Instant", "java.time.Instant"),
        ("LocalDate", "java.time.LocalDate"),
        ("LocalTime", "java.time.LocalTime"),
        ("UUID", "java.util.UUID"),
    ]
    return _imports_header(body, imports, "")


# Java

_JAVA_TYPES = {
    "string": "String",
    "decimal": "BigDecimal",
    "date": "LocalDate",
    "datetime": "OffsetDateTime",
    "time": "LocalTime",
    "duration": "Duration",
    "uuid": "UUID",
    "binary": "byte[]",
    "any": "Object",
}


def _java_type(type_ref: dict, names: dict, boxed: bool = False) -> str:
    kind = type_ref["kind"]
    if kind == "primitive":
        name = type_ref["name"]
        if name == "integer":
            if _small_integer(type_ref):
                return "Integer" if boxed else "int"
            return "Long" if boxed else "long"
        if name == "float":
            return "Double" if boxed else "double"
        if name == "boolean":
            return "Boolean" if boxed else "boolean"
        return _JAVA_TYPES.get(name, "Object")
    if kind == "array":
        return f"List<{_java_type(type_ref['items'], names, True)}>"
    if kind == "map":
        return f"Map<String, {_java_type(type_ref['value'], names, True)}>"
    if kind in ("model", "enum"):
        return _ref(type_ref, names)
    return "Object"


def _java_model(name: str, model: dict, fields: list, names: dict) -> str:
    # A record per model: fields that may be missing use boxed types, so they can be null
    lines = [
        f"        {_java_type(field['type'], names, _missing_allowed(field))} {field_name}"
        for field_name, field in fields
    ]
    return f"{_jsdoc(model.get('description'))}public record {name}(\n" + ",\n".join(lines) + "\n) {\n}"


def _java_enum(name: str, enum_def: dict) -> str:
    values = ",\n    ".join(to_screaming_snake_case(value["name"]) or "VALUE" for value in enum_def["values"])
    return f"public enum {name} {{\n    {values}\n}}"


def _java_header(body: str) -> str:
    imports = [
        ("BigDecimal", "java.math.BigDecimal"),
        ("Duration", "java.time.Duration"),
        ("LocalDate", "java.time.LocalDate"),
        ("LocalTime", "java.time.LocalTime"),
        ("OffsetDateTime", "java.time.OffsetDateTime"),
        ("List", "java.util.List"),
        ("Map", "java.util.Map"),
        ("UUID", "java.util.UUID"),
    ]
    return _imports_header(body, imports, ";")


# C#

_CSHARP_TYPES = {
    "string": "string",
    "float": "double",
    "decimal": "decimal",
    "boolean": "bool",
    "date": "DateOnly",
    "datetime": "DateTime",
    "time": "TimeOnly",
    "duration": "TimeSpan",
    "uuid": "Guid",
    "binary": "byte[]",
    "any": "object",
}


def _csharp_type(type_ref: dict, names: dict) -> str:
    kind = type_ref["kind"]
    if kind == "primitive":
        if type_ref["name"] == "integer":
            return "int" if _small_integer(type_ref) else "long"
        return _CSHARP_TYPES.get(type_ref["name"], "object")
    if kind == "array":
        return f"List<{_csharp_type(type_ref['items'], names)}>"
    if kind == "map":
        return f"Dictionary<string, {_csharp_type(type_ref['value'], names)}>"
    if kind in ("model", "enum"):
        return _ref(type_ref, names)
    return "object"


def _csharp_model(name: str, model: dict, fields: list, names: dict) -> str:
    # required for values that must be given; nullable types for the rest
    lines = []
    for field_name, field in fields:
        allowed = _missing_allowed(field)
        written = f"{_csharp_type(field['type'], names)}{'?' if allowed else ''}"
        lines.append(f"    public {'' if allowed else 'required '}{written} {field_name} {{ get; set; }}")
    summary = f"/// <summary>{model['description']}</summary>\n" if model.get("description") else ""
    return f"{summary}public class {name}\n{{\n" + "\n".join(lines) + "\n}"


def _csharp_enum(name: str, enum_def: dict) -> str:
    values = ",\n    ".join(to_pascal_case(value["name"]) or "Value" for value in enum_def["values"])
    return f"public enum {name}\n{{\n    {values}\n}}"


# Format → (field naming convention, model, enum, header)
_WRITERS = {
    "typescript": ("camelCase", _ts_model, _ts_enum, None),
    "python": ("snake_case", _python_model, _python_enum, _python_header),
    "kotlin": ("camelCase", _kotlin_model, _kotlin_enum, _kotlin_header),
    "java": ("camelCase", _java_model, _java_enum, _java_header),
    "csharp": ("PascalCase", _csharp_model, _csharp_enum, None),
}

_DIGIT_START = re.compile(r"^[0-9]")


def _field_names(model: dict, convention: str) -> list[tuple[str, dict]]:
    used: set[str] = set()
    result = []
    for field in model["fields"]:
        name = convert_case(field["name"], convention) or "field"
        if _DIGIT_START.match(name):
            name = f"_{name}"
        n = 2
        while name in used:
            name = f"{convert_case(field['name'], convention)}{n}"
            n += 1
        used.add(name)
        result.append((name, field))
    return result


_JSON_FORMATS = {
    "string": {"type": "string"},
    "float": {"type": "number"},
    "decimal": {"type": "number"},
    "boolean": {"type": "boolean"},
    "date": {"type": "string", "format": "date"},
    "datetime": {"type": "string", "format": "date-time"},
    "time": {"type": "string", "format": "time"},
    "duration": {"type": "string", "format": "duration"},
    "uuid": {"type": "string", "format": "uuid"},
    "binary": {"type": "string", "contentEncoding": "base64"},
    "any": {},
}


def _json_schema_type(type_ref: dict, names: dict, nullable: bool) -> dict:
    def write(item: dict) -> dict:
        kind = item["kind"]
        if kind == "primitive":
            if item["name"] == "integer":
                return {"type": "integer", "format": "int32"} if item.get("bits") == 32 else {"type": "integer"}
            return dict(_JSON_FORMATS[item["name"]])
        if kind == "array":
            return {"type": "array", "items": write(item["items"])}
        if kind == "map":
            return {"type": "object", "additionalProperties": write(item["value"])}
        if kind in ("model", "enum"):
            return {"$ref": f"#/$defs/{_ref(item, names)}"}
        return {}

    schema = write(type_ref)
    if not nullable:
        return schema
    if isinstance(schema.get("type"), str):
        return {**schema, "type": [schema["type"], "null"]}
    return {"oneOf": [schema, {"type": "null"}]}


def _write_json_schema(collected: dict, root: str) -> str:
    names = collected["names"]

    def object_schema(model: dict) -> dict:
        fields = _field_names(model, "camelCase")
        properties = {}
        for name, field in fields:
            prop = _json_schema_type(field["type"], names, field["nullable"])
            if field.get("description"):
                prop["description"] = field["description"]
            properties[name] = prop
        required = [name for name, field in fields if not field["optional"]]
        result: dict = {"type": "object"}
        if model.get("description"):
            result["description"] = model["description"]
        result["properties"] = properties
        if required:
            result["required"] = required
        return result

    root_model = next(model for model in collected["models"] if model["name"] == root)
    defs: dict = {}
    for enum_def in collected["enums"]:
        defs[names[enum_def["name"]]] = {
            "enum": [coalesce(value.get("value"), value["name"]) for value in enum_def["values"]]
        }
    for model in collected["models"]:
        if model is not root_model:
            defs[names[model["name"]]] = object_schema(model)
    document = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": names.get(root),
        **object_schema(root_model),
    }
    if defs:
        document["$defs"] = defs
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def draft_target(source: dict, root: str, format_id: str) -> dict | None:
    """The new target model as text in the chosen format, and the name of its root model: {"text", "model"}."""
    if not find_model(source, root):
        return None
    collected = _collect(source, root)
    names = collected["names"]
    model = names[root]
    if format_id == "jsonschema":
        return {"text": _write_json_schema(collected, root), "model": model}
    convention, write_model, write_enum, header = _WRITERS[format_id]
    blocks = [write_enum(names[enum_def["name"]], enum_def) for enum_def in collected["enums"]] + [
        write_model(names[item["name"]], item, _field_names(item, convention), names) for item in collected["models"]
    ]
    body = ("\n\n\n" if format_id == "python" else "\n\n").join(blocks)
    return {"text": f"{header(body) if header else body}\n", "model": model}
