"""Strict JSON (RFC 8259) parser that reports where the text is wrong. Mirrors
web/src/core/parsers/data/jsonText.ts, adapted from Api2Class: both tools report JSON errors alike.

Values are dictionaries: {"kind": "object", "entries": [(key, value)]}, {"kind": "array", "items"},
{"kind": "string", "value"}, {"kind": "number", "text", "integer"}, {"kind": "boolean", "value"},
{"kind": "null"}. Numbers keep their text so 29.0 (float) and 29 (integer) stay different, and object
entries keep their order, duplicates included.
"""

import re
import sys
from typing import Any

JsonValue = dict[str, Any]

# Deeper documents are almost certainly not API responses, and the limit avoids a recursion error
MAX_DEPTH = 512

_NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?")
_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}
_HEX4 = re.compile(r"[0-9a-fA-F]{4}")
_WHITESPACE = " \t\n\r"
_WORDS = (("true", {"kind": "boolean", "value": True}), ("false", {"kind": "boolean", "value": False}))


class _JsonError(Exception):
    def __init__(self, code: str, index: int, expected: str | None = None, key: str | None = None):
        super().__init__(code)
        self.code = code
        self.index = index
        self.expected = expected
        self.key = key


class _Parser:
    def __init__(self, source: str):
        self.source = source
        self.index = 0

    def fail(self, code: str, expected: str | None = None, key: str | None = None):
        raise _JsonError(code, self.index, expected, key)

    def unexpected(self, expected: str | None = None, key: str | None = None):
        self.fail("unexpectedEnd" if self.index >= len(self.source) else "unexpectedCharacter", expected, key)

    def peek(self) -> str | None:
        return self.source[self.index] if self.index < len(self.source) else None

    def skip_whitespace(self):
        source = self.source
        while self.index < len(source) and source[self.index] in _WHITESPACE:
            self.index += 1

    def expect(self, char: str, expected: str, key: str | None):
        if self.peek() != char:
            self.unexpected(expected, key)
        self.index += 1

    def parse_value(self, depth: int, key: str | None = None) -> JsonValue:
        if depth > MAX_DEPTH:
            self.fail("tooDeep")
        self.skip_whitespace()
        char = self.peek()
        if char == "{":
            return self.parse_object(depth)
        if char == "[":
            return self.parse_array(depth, key)
        if char == '"':
            return {"kind": "string", "value": self.parse_string()}
        if char is not None and (char == "-" or "0" <= char <= "9"):
            return self.parse_number()
        for word, value in _WORDS:
            if self.source.startswith(word, self.index):
                self.index += len(word)
                return dict(value)
        if self.source.startswith("null", self.index):
            self.index += 4
            return {"kind": "null"}
        self.unexpected("value", key)

    def parse_object(self, depth: int) -> JsonValue:
        entries: list = []
        self.index += 1
        self.skip_whitespace()
        if self.peek() == "}":
            self.index += 1
            return {"kind": "object", "entries": entries}
        while True:
            self.skip_whitespace()
            previous = entries[-1][0] if entries else None
            if self.peek() == "}" and entries:
                self.fail("trailingComma", key=previous)
            if self.peek() != '"':
                self.unexpected("key", previous)
            key = self.parse_string()
            self.skip_whitespace()
            self.expect(":", "colon", key)
            entries.append((key, self.parse_value(depth + 1, key)))
            self.skip_whitespace()
            if self.peek() == ",":
                self.index += 1
                continue
            self.expect("}", "commaOrBrace", key)
            return {"kind": "object", "entries": entries}

    def parse_array(self, depth: int, key: str | None) -> JsonValue:
        items: list = []
        self.index += 1
        self.skip_whitespace()
        if self.peek() == "]":
            self.index += 1
            return {"kind": "array", "items": items}
        while True:
            self.skip_whitespace()
            if self.peek() == "]" and items:
                self.fail("trailingComma", key=key)
            items.append(self.parse_value(depth + 1, key))
            self.skip_whitespace()
            if self.peek() == ",":
                self.index += 1
                continue
            self.expect("]", "commaOrBracket", key)
            return {"kind": "array", "items": items}

    def parse_string(self) -> str:
        self.index += 1
        parts: list[str] = []
        source = self.source
        while True:
            if self.index >= len(source):
                self.fail("unexpectedEnd")
            char = source[self.index]
            if char == '"':
                self.index += 1
                return "".join(parts)
            if char < " ":
                self.fail("controlCharacter")
            if char != "\\":
                parts.append(char)
                self.index += 1
                continue
            self.index += 1
            escape = self.peek()
            if escape is None:
                self.fail("unexpectedEnd")
            if escape in _ESCAPES:
                parts.append(_ESCAPES[escape])
                self.index += 1
            elif escape == "u" and _HEX4.fullmatch(source, self.index + 1, self.index + 5):
                code = int(source[self.index + 1 : self.index + 5], 16)
                self.index += 5
                # A surrogate pair written as two escapes is one character, as in JavaScript
                if 0xD800 <= code <= 0xDBFF and source.startswith("\\u", self.index):
                    low_text = source[self.index + 2 : self.index + 6]
                    if _HEX4.fullmatch(low_text) and 0xDC00 <= int(low_text, 16) <= 0xDFFF:
                        code = 0x10000 + ((code - 0xD800) << 10) + (int(low_text, 16) - 0xDC00)
                        self.index += 6
                parts.append(chr(code))
            else:
                self.fail("invalidEscape")

    def parse_number(self) -> JsonValue:
        match = _NUMBER.match(self.source, self.index)
        if not match:
            self.fail("invalidNumber")
        self.index = match.end()
        # 012, 1., 1e: a number followed by more number characters is malformed, not two values
        following = self.peek()
        if following is not None and following in "0123456789.eE+-":
            self.fail("invalidNumber")
        return {"kind": "number", "text": match.group(0), "integer": match.group(1) is None and match.group(2) is None}


def parse_json(text: str) -> dict:
    """{"ok": True, "value"} or {"ok": False, "error": {"code", "line", "column", "found"?, "expected"?, "key"?}}."""
    # A byte order mark is invisible when pasting from some editors
    source = text[1:] if text.startswith("﻿") else text
    parser = _Parser(source)
    # Two calls per level (value and array or object): Python's default limit of 1000 is not enough
    limit = sys.getrecursionlimit()
    sys.setrecursionlimit(max(limit, MAX_DEPTH * 3 + 200))
    try:
        parser.skip_whitespace()
        if parser.index >= len(source):
            parser.fail("empty")
        value = parser.parse_value(1)
        parser.skip_whitespace()
        if parser.index < len(source):
            parser.fail("trailingContent")
        return {"ok": True, "value": value}
    except _JsonError as error:
        return {"ok": False, "error": _error_info(source, error)}
    finally:
        sys.setrecursionlimit(limit)


def _error_info(source: str, error: _JsonError) -> dict:
    before = source[: error.index]
    line_start = before.rfind("\n") + 1
    info: dict = {"code": error.code, "line": before.count("\n") + 1, "column": error.index - line_start + 1}
    if error.index < len(source) and error.code != "empty":
        info["found"] = source[error.index]
    if error.expected:
        info["expected"] = error.expected
    if error.key is not None:
        info["key"] = error.key
    return info
