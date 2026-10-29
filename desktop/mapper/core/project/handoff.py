"""Passing a model between the tools of the family (Api2Class → Mapper → Model2DB). Mirrors
web/src/core/project/handoff.ts. The desktop version receives a handoff as a file; the contract is documented
in docs/interoperability.md."""

import json

from ..js import parse_json_value
from ..parsers.schema.model_schema import validate_model_schema

HANDOFF_FORMAT = "model-handoff"
HANDOFF_VERSION = 1
# Far above any model
MAX_HANDOFF_SIZE = 4 * 1024 * 1024
TOOLS = ("api2class", "mapper", "model2db", "datacleanr")


def read_handoff(value) -> dict | None:
    """Checks a received handoff (its text, or the value already read). Anything unexpected is rejected: the
    content comes from outside the application."""
    if isinstance(value, str):
        if len(value) > MAX_HANDOFF_SIZE:
            return None
        try:
            return read_handoff(parse_json_value(value))
        except (ValueError, RecursionError):
            return None
    if not isinstance(value, dict):
        return None
    if (
        value.get("format") != HANDOFF_FORMAT
        or value.get("version") != HANDOFF_VERSION
        or isinstance(value.get("version"), bool)
    ):
        return None
    if value.get("from") not in TOOLS or value.get("role") not in ("source", "target"):
        return None
    schema = validate_model_schema(value.get("schema"))
    if not schema["ok"]:
        return None
    result = {
        "format": HANDOFF_FORMAT,
        "version": HANDOFF_VERSION,
        "from": value["from"],
        "role": value["role"],
        "schema": schema["schema"],
    }
    model = value.get("model")
    if isinstance(model, str) and any(item["name"] == model for item in schema["schema"]["models"]):
        result["model"] = model
    text = value.get("text")
    if (
        isinstance(text, dict)
        and isinstance(text.get("format"), str)
        and isinstance(text.get("content"), str)
        and len(text["content"]) <= MAX_HANDOFF_SIZE
    ):
        result["text"] = {"format": text["format"], "content": text["content"]}
    return result


def create_handoff(origin: str, role: str, schema: dict, model: str | None = None) -> dict:
    handoff = {"format": HANDOFF_FORMAT, "version": HANDOFF_VERSION, "from": origin, "role": role, "schema": schema}
    if model:
        handoff["model"] = model
    return handoff


def schema_text(schema: dict) -> str:
    """A schema written as the web version writes it (JSON.stringify with two spaces)."""
    return json.dumps(schema, ensure_ascii=False, indent=2)
