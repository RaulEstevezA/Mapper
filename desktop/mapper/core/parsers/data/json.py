"""A JSON document used as an example of the model: an API response, a message, a saved record.
Mirrors web/src/core/parsers/data/json.ts."""

from ..types import InputParser, failure, root_name
from .infer import infer_schema
from .json_text import parse_json


def _detect(text: str) -> float:
    from ...js import trim_start

    start = trim_start(text)[:1]
    return 0.8 if start in ("{", "[") and start else 0


def _parse(text: str, options: dict | None = None) -> dict:
    result = parse_json(text)
    if not result["ok"]:
        error = result["error"]
        if error["code"] == "empty":
            return failure("empty")
        params = {"detail": f"json.{error['code']}"}
        for name in ("found", "expected", "key"):
            if name in error:
                params[name] = error[name]
        return failure("syntax", {"line": error["line"], "column": error["column"]}, params)
    return from_data_value(result["value"], root_name(options, "Root"), "json")


def from_data_value(value: dict, root_name: str, format_id: str) -> dict:
    inferred = infer_schema(value, root_name, format_id)
    if not inferred:
        return failure("noModels")
    return {"ok": True, "schema": inferred["schema"], "warnings": inferred["warnings"]}


json_parser = InputParser("json", "data", "JSON", (".json",), "json", _detect, _parse)
