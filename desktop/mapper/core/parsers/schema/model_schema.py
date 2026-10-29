"""A ModelSchema document, the format shared by Api2Class, Mapper and Model2DB (docs/interoperability.md).
Mirrors web/src/core/parsers/schema/modelSchema.ts."""

import re

from ...js import is_number
from ...model.schema import MODEL_SCHEMA_FORMAT, MODEL_SCHEMA_VERSION, PRIMITIVES
from ..types import InputParser, failure
from .json_schema import read_structured


def _valid_type(value, depth: int = 0) -> bool:
    if not isinstance(value, dict) or depth > 32:
        return False
    kind = value.get("kind")
    if kind == "primitive":
        return value.get("name") in PRIMITIVES
    if kind == "array":
        return _valid_type(value.get("items"), depth + 1)
    if kind == "map":
        return _valid_type(value.get("key"), depth + 1) and _valid_type(value.get("value"), depth + 1)
    if kind in ("model", "enum", "unknown"):
        return isinstance(value.get("name"), str)
    return False


def validate_model_schema(value) -> dict:
    """Checks a document received from another tool or a file: {"ok": True, "schema"} or {"ok": False, "path"}.
    Anything unexpected is rejected with the path where it was found, instead of being trusted."""
    if not isinstance(value, dict):
        return {"ok": False, "path": "$"}
    if value.get("format") != MODEL_SCHEMA_FORMAT:
        return {"ok": False, "path": "$.format"}
    if not (is_number(value.get("version")) and value["version"] == MODEL_SCHEMA_VERSION):
        return {"ok": False, "path": "$.version"}
    if not isinstance(value.get("models"), list):
        return {"ok": False, "path": "$.models"}
    enums = value.get("enums")
    enums = [] if enums is None else enums
    if not isinstance(enums, list):
        return {"ok": False, "path": "$.enums"}
    for index, model in enumerate(value["models"]):
        if (
            not isinstance(model, dict)
            or not isinstance(model.get("name"), str)
            or not isinstance(model.get("fields"), list)
        ):
            return {"ok": False, "path": f"$.models[{index}]"}
        for field_index, field in enumerate(model["fields"]):
            path = f"$.models[{index}].fields[{field_index}]"
            if not isinstance(field, dict) or not isinstance(field.get("name"), str):
                return {"ok": False, "path": path}
            if not _valid_type(field.get("type")):
                return {"ok": False, "path": f"{path}.type"}
            if not isinstance(field.get("nullable"), bool) or not isinstance(field.get("optional"), bool):
                return {"ok": False, "path": path}
    for index, item in enumerate(enums):
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("name"), str)
            or not isinstance(item.get("values"), list)
            or not all(isinstance(entry, dict) and isinstance(entry.get("name"), str) for entry in item["values"])
        ):
            return {"ok": False, "path": f"$.enums[{index}]"}
    schema = {
        **value,
        "enums": enums,
        "models": [
            {**model, "kind": "object" if model.get("kind") is None else model["kind"]} for model in value["models"]
        ],
    }
    return {"ok": True, "schema": schema}


_FORMAT = re.compile(r"\"format\"\s*:\s*\"model-schema\"")


def _detect(text: str) -> float:
    return 1 if _FORMAT.search(text[:2000]) else 0


def _parse(text: str, options: dict | None = None) -> dict:
    read = read_structured(text)
    if not read["ok"]:
        return read["outcome"]
    validated = validate_model_schema(read["value"])
    if not validated["ok"]:
        return failure("syntax", None, {"detail": "modelSchema", "path": validated["path"]})
    if not validated["schema"]["models"]:
        return failure("noModels")
    return {"ok": True, "schema": validated["schema"], "warnings": []}


model_schema_parser = InputParser(
    "modelschema", "schema", "Model schema (Api2Class, Mapper)", (".model.json",), "json", _detect, _parse
)
