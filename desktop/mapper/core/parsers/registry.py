"""Every parser, format detection and the single entry point to read an input. Mirrors
web/src/core/parsers/registry.ts."""

from ..js import trim
from .code.csharp import csharp_parser
from .code.dart import dart_parser
from .code.go import go_parser
from .code.java import java_parser
from .code.kotlin import kotlin_parser
from .code.php import php_parser
from .code.python import python_parser
from .code.rust import rust_parser
from .code.scala import scala_parser
from .code.swift import swift_parser
from .code.typescript import javascript_parser, typescript_parser
from .data.csv import csv_parser
from .data.json import json_parser
from .data.xml import xml_parser
from .data.yaml import yaml_parser
from .schema.graphql import graphql_parser
from .schema.json_schema import json_schema_parser
from .schema.model_schema import model_schema_parser
from .schema.openapi import openapi_parser
from .schema.prisma import prisma_parser
from .schema.protobuf import protobuf_parser
from .schema.smithy import smithy_parser
from .types import InputParser

# Every parser, in the order the format selector shows them. Adding a format means adding it here.
PARSERS: tuple[InputParser, ...] = (
    json_parser,
    json_schema_parser,
    openapi_parser,
    yaml_parser,
    xml_parser,
    csv_parser,
    graphql_parser,
    protobuf_parser,
    prisma_parser,
    model_schema_parser,
    typescript_parser,
    javascript_parser,
    python_parser,
    java_parser,
    csharp_parser,
    kotlin_parser,
    dart_parser,
    swift_parser,
    go_parser,
    rust_parser,
    php_parser,
    scala_parser,
    smithy_parser,
)


def find_parser(format_id: str) -> InputParser | None:
    return next((parser for parser in PARSERS if parser.id == format_id), None)


# Below this, a guess would be wrong more often than right: the user chooses
MIN_SCORE = 0.3


def detect_formats(text: str, file_name: str | None = None) -> list[dict]:
    """Formats the text may be in, most likely first: [{"id", "score"}]. A file name with a known extension
    decides it."""
    lower = (file_name or "").lower()
    sample = text[:20000] if len(text) > 20000 else text
    detections = []
    for parser in PARSERS:
        score = parser.detect(sample)
        # The longest matching extension wins: .schema.json over .json
        matching = sorted((item for item in parser.extensions if lower.endswith(item)), key=len, reverse=True)
        if matching:
            score = max(score, 0.9) + len(matching[0]) / 100
        detections.append({"id": parser.id, "score": score})
    # sorted() is stable, like Array.prototype.sort
    return sorted((item for item in detections if item["score"] >= MIN_SCORE), key=lambda item: -item["score"])


def detect_format(text: str, file_name: str | None = None) -> str | None:
    detections = detect_formats(text, file_name)
    return detections[0]["id"] if detections else None


def parse_input(text: str, format_id: str, options: dict | None = None) -> dict:
    parser = find_parser(format_id)
    if not parser:
        return {"ok": False, "error": {"code": "syntax", "params": {"message": f"Unknown format {format_id}"}}}
    if trim(text) == "":
        return {"ok": False, "error": {"code": "empty"}}
    try:
        return parser.parse(text, options)
    except Exception as error:  # noqa: BLE001
        # A parser bug must never break the window: report it as an input the format cannot read
        return {"ok": False, "error": {"code": "syntax", "params": {"message": str(error)}}}


def accepted_extensions() -> list[str]:
    """File extensions accepted by the file picker: only those of formats that can really be read."""
    return list(dict.fromkeys(extension for parser in PARSERS for extension in parser.extensions))
