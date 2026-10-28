"""What every input parser offers. Mirrors web/src/core/parsers/types.ts.

A parse outcome is a dictionary: {"ok": True, "schema", "warnings"} or {"ok": False, "error"}, where an
issue is {"code", "line"?, "column"?, "params"?}. Codes are translated by the interface.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

ParseIssue = dict[str, Any]
ParseOutcome = dict[str, Any]


@dataclass(frozen=True)
class InputParser:
    id: str
    # data, schema or code
    kind: str
    # Shown in the format selector
    label: str
    # File extensions it reads, with the dot
    extensions: tuple[str, ...]
    # Highlighting used by the editor
    editor_language: str
    # How likely it is that the text is in this format, from 0 (not at all) to 1 (certain). Cheap: it looks
    # for telltale syntax and does not parse the whole text.
    detect: Callable[[str], float]
    parse: Callable[..., ParseOutcome]


def failure(code: str, position: dict | None = None, params: dict | None = None) -> ParseOutcome:
    error: ParseIssue = {"code": code}
    if position:
        error.update(position)
    if params:
        error["params"] = params
    return {"ok": False, "error": error}


def position_at(text: str, index: int) -> dict:
    """1-based line and column of an index of the text, counted in characters."""
    before = text[:index]
    line_start = before.rfind("\n") + 1
    return {"line": before.count("\n") + 1, "column": len(before) - line_start + 1}


def root_name(options: dict | None, default: str) -> str:
    """options.rootName ?? default: an empty name is kept, as in the web version."""
    name = (options or {}).get("rootName")
    return default if name is None else name
