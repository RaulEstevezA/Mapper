"""The models of an OpenAPI 3 (components.schemas) or Swagger 2 (definitions) document. Mirrors
web/src/core/parsers/schema/openapi.ts."""

import re

from ..types import InputParser, failure
from .json_schema import convert_schemas, read_structured

_VERSION = re.compile(r"^\s*[\"']?(openapi|swagger)[\"']?\s*:\s*[\"']?[23]\.", re.MULTILINE)


def _detect(text: str) -> float:
    return 0.99 if _VERSION.search(text[:2000]) else 0


def _parse(text: str, options: dict | None = None) -> dict:
    read = read_structured(text)
    if not read["ok"]:
        return read["outcome"]
    document = read["value"]
    if not isinstance(document, (dict, list)):
        return failure("noModels")
    record = document if isinstance(document, dict) else {}
    components = record.get("components")
    schemas = components.get("schemas") if isinstance(components, dict) else None
    converted = convert_schemas(
        [("#/components/schemas/", schemas), ("#/definitions/", record.get("definitions"))], None, "Root", "openapi"
    )
    if not converted["schema"]["models"]:
        return failure("noModels")
    return {"ok": True, "schema": converted["schema"], "warnings": converted["warnings"]}


openapi_parser = InputParser("openapi", "schema", "OpenAPI / Swagger", (), "yaml", _detect, _parse)
