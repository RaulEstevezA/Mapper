"""The language-neutral description of data models. Mirrors web/src/core/model/schema.ts.

A schema is a dictionary: {"format": "model-schema", "version": 1, "origin"?, "models", "enums", "root"?}.
Types are dictionaries too: {"kind": "primitive", "name": "integer", "bits"?: 32}, {"kind": "array", "items"},
{"kind": "map", "key", "value"}, {"kind": "model" | "enum" | "unknown", "name"}.
"""

from typing import Any

MODEL_SCHEMA_FORMAT = "model-schema"
MODEL_SCHEMA_VERSION = 1

PRIMITIVES = (
    "string",
    "integer",
    "float",
    "decimal",
    "boolean",
    "date",
    "datetime",
    "time",
    "duration",
    "uuid",
    "binary",
    "any",
)

TypeRef = dict[str, Any]
FieldDef = dict[str, Any]
ModelDef = dict[str, Any]
EnumDef = dict[str, Any]
ModelSchema = dict[str, Any]


def empty_schema(origin: dict | None = None) -> ModelSchema:
    schema: ModelSchema = {"format": MODEL_SCHEMA_FORMAT, "version": MODEL_SCHEMA_VERSION}
    if origin is not None:
        schema["origin"] = origin
    schema["models"] = []
    schema["enums"] = []
    return schema


def find_model(schema: ModelSchema, name: str) -> ModelDef | None:
    return next((model for model in schema["models"] if model["name"] == name), None)


def find_enum(schema: ModelSchema, name: str) -> EnumDef | None:
    return next((item for item in schema["enums"] if item["name"] == name), None)


def all_fields(schema: ModelSchema, model: ModelDef, seen: set[str] | None = None) -> list[FieldDef]:
    """Fields of a model including the inherited ones, parents first; a field redeclared in a child wins."""
    seen = set() if seen is None else seen
    if model["name"] in seen:
        return model["fields"]
    seen.add(model["name"])
    inherited: list[FieldDef] = []
    for parent in model.get("extends") or []:
        found = find_model(schema, parent)
        if found:
            inherited.extend(all_fields(schema, found, seen))
    own = {field["name"] for field in model["fields"]}
    return [field for field in inherited if field["name"] not in own] + list(model["fields"])


def needs_value(field: FieldDef) -> bool:
    """A target field that must receive a value: it cannot be missing or null and has no default."""
    return (
        not field["optional"] and not field["nullable"] and "defaultValue" not in field and not field.get("generated")
    )


def default_root(schema: ModelSchema) -> str | None:
    """The model chosen by default: the declared root, or the model no other model refers to, or the first."""
    if schema.get("root") and find_model(schema, schema["root"]):
        return schema["root"]
    referenced: set[str] = set()
    for model in schema["models"]:
        for field in model["fields"]:
            inner = model_of(field["type"])
            if inner and inner != model["name"]:
                referenced.add(inner)
    for model in schema["models"]:
        if model["name"] not in referenced and model["fields"]:
            return model["name"]
    return schema["models"][0]["name"] if schema["models"] else None


def model_of(type_ref: TypeRef) -> str | None:
    """The model a type leads to, directly or through arrays and maps (Order[] → Order)."""
    kind = type_ref["kind"]
    if kind == "model":
        return type_ref["name"]
    if kind == "array":
        return model_of(type_ref["items"])
    if kind == "map":
        return model_of(type_ref["value"])
    return None


def describe_type(type_ref: TypeRef) -> str:
    """Language-neutral description of a type for the interface: integer, Order[], map<string, float>."""
    kind = type_ref["kind"]
    if kind == "primitive":
        bits = type_ref.get("bits")
        return f"{type_ref['name']}{bits}" if bits and type_ref["name"] in ("integer", "float") else type_ref["name"]
    if kind == "array":
        items = describe_type(type_ref["items"])
        return f"({items} | null)[]" if type_ref.get("itemsNullable") else f"{items}[]"
    if kind == "map":
        return f"map<{describe_type(type_ref['key'])}, {describe_type(type_ref['value'])}>"
    return type_ref["name"]


def primitive(name: str, bits: int | None = None) -> TypeRef:
    return {"kind": "primitive", "name": name, "bits": bits} if bits else {"kind": "primitive", "name": name}


def same_type(a: TypeRef, b: TypeRef) -> bool:
    return a == b
