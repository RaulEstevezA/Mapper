"""CSV and TSV files: a header row and rows of values. Mirrors web/src/core/parsers/data/csv.ts."""

import math
import re

from ...js import trim, trim_start
from ..types import InputParser, failure, position_at, root_name
from .json import from_data_value

# Enough rows to see every kind of value a column holds, without slowing down with a huge file
MAX_ROWS = 2000
_DELIMITERS = (",", ";", "\t", "|")
_INTEGER = re.compile(r"-?(0|[1-9][0-9]*)")
_FLOAT = re.compile(r"-?(0|[1-9][0-9]*)\.[0-9]+")
_LINE_BREAK = re.compile(r"\r?\n")


def _detect_delimiter(first_line: str) -> str:
    """The delimiter that splits the first line into the most columns."""
    best, best_count = ",", 0
    for delimiter in _DELIMITERS:
        count = first_line.count(delimiter)
        if count > best_count:
            best, best_count = delimiter, count
    return best


def read_csv(text: str, delimiter: str, max_rows: float = math.inf) -> tuple[list[list[str]], int | None]:
    """RFC 4180 rows: quoted fields may contain the delimiter, quotes ("") and line breaks. Returns the rows
    and where an unterminated quote starts (None when every quote is closed)."""
    rows: list[list[str]] = []
    row: list[str] = []
    field: list[str] = []
    quoted = False
    quote_start = 0
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if quoted:
            if char == '"':
                if index + 1 < length and text[index + 1] == '"':
                    field.append('"')
                    index += 1
                else:
                    quoted = False
            else:
                field.append(char)
            index += 1
            continue
        if char == '"' and not field:
            quoted = True
            quote_start = index
        elif char == delimiter:
            row.append("".join(field))
            field = []
        elif char in "\n\r":
            if char == "\r" and index + 1 < length and text[index + 1] == "\n":
                index += 1
            row.append("".join(field))
            field = []
            if any(cell != "" for cell in row) or len(row) > 1:
                rows.append(row)
            row = []
            if len(rows) > max_rows:
                break
        else:
            field.append(char)
        index += 1
    if quoted:
        return rows, quote_start
    row.append("".join(field))
    if any(cell != "" for cell in row):
        rows.append(row)
    return rows, None


def typed_cell(cell: str) -> dict:
    """A CSV cell as a typed value: CSV is all text, so numbers and booleans are recognized by their look.
    Numbers with leading zeros (zip codes, phone numbers) stay text."""
    value = trim(cell)
    if value == "":
        return {"kind": "null"}
    if _INTEGER.fullmatch(value) and len(value) < 16:
        return {"kind": "number", "text": value, "integer": True}
    if _FLOAT.fullmatch(value):
        return {"kind": "number", "text": value, "integer": False}
    if value.lower() in ("true", "false"):
        return {"kind": "boolean", "value": value.lower() == "true"}
    return {"kind": "string", "value": value}


def _detect(text: str) -> float:
    lines = _LINE_BREAK.split(trim(text))[:5]
    first = trim_start(text)[:1]
    if len(lines) < 2 or (first and re.match(r"[\s{\[<]", first)):
        return 0
    delimiter = _detect_delimiter(lines[0])
    counts = [len(line.split(delimiter)) for line in lines]
    if counts[0] < 2 or any(count != counts[0] for count in counts):
        return 0
    # Code rarely has every line split into the same number of comma-separated parts, but check for braces
    return 0.15 if re.search(r"[{};()]", text) else 0.6


def _parse(text: str, options: dict | None = None) -> dict:
    if trim(text) == "":
        return failure("empty")
    source = text[1:] if text.startswith("﻿") else text
    delimiter = _detect_delimiter(_LINE_BREAK.split(source, maxsplit=1)[0])
    rows, unterminated_at = read_csv(source, delimiter, MAX_ROWS + 1)
    if unterminated_at is not None:
        return failure("unterminatedString", position_at(source, unterminated_at))
    if not rows or all(trim(cell) == "" for cell in rows[0]):
        return failure("noModels")
    header, data = rows[0], rows[1:]
    names = [trim(cell) or f"column{index + 1}" for index, cell in enumerate(header)]
    objects = [
        {
            "kind": "object",
            "entries": [(name, typed_cell(row[index] if index < len(row) else "")) for index, name in enumerate(names)],
        }
        for row in (data if data else [["" for _ in names]])[:MAX_ROWS]
    ]
    outcome = from_data_value({"kind": "array", "items": objects}, root_name(options, "Row"), "csv")
    if not outcome["ok"]:
        return outcome
    # A column that is always empty is still a text column, not a value of unknown shape
    for field in outcome["schema"]["models"][0]["fields"]:
        if field["type"] == {"kind": "primitive", "name": "any"}:
            field["type"] = {"kind": "primitive", "name": "string"}
    if len(data) > MAX_ROWS:
        outcome["warnings"].append({"code": "truncatedRows", "params": {"rows": MAX_ROWS}})
    return outcome


csv_parser = InputParser("csv", "data", "CSV", (".csv", ".tsv"), "text", _detect, _parse)
