"""Swift structs, classes, actors and enums, with Codable CodingKeys. Mirrors web/src/core/parsers/code/swift.ts."""

import re

from ...js import to_number
from ...model.schema import primitive
from ..types import InputParser
from .lexer import Cursor, LexerConfig, StringRule
from .raw import MISSING, TypeTable, parse_declarations, parse_literal, raw
from .type_syntax import TypeSyntax, read_type

_LEXER = LexerConfig(
    line_comments=("//",),
    block_comments=(("/*", "*/"),),
    nested_comments=True,
    strings=(StringRule('"""', '"""', True, True), StringRule('"', '"', True, False)),
)

_SYNTAX = TypeSyntax(generics="<>", nullable_suffix=True, bracket_collections=True)

SWIFT_TYPES = TypeTable(
    primitives={
        "String": primitive("string"),
        "Character": primitive("string"),
        "Substring": primitive("string"),
        "Int": primitive("integer", 64),
        "Int64": primitive("integer", 64),
        "Int32": primitive("integer", 32),
        "Int16": primitive("integer", 16),
        "Int8": primitive("integer", 8),
        "UInt": primitive("integer", 64),
        "UInt64": primitive("integer", 64),
        "UInt32": primitive("integer", 32),
        "Double": primitive("float", 64),
        "Float": primitive("float", 32),
        "CGFloat": primitive("float", 64),
        "Decimal": primitive("decimal"),
        "Bool": primitive("boolean"),
        "Date": primitive("datetime"),
        "UUID": primitive("uuid"),
        "Data": primitive("binary"),
        "URL": primitive("string"),
        "TimeInterval": primitive("duration"),
        "Any": primitive("any"),
        "AnyHashable": primitive("any"),
    },
    lists=("Array", "Set", "ContiguousArray"),
    maps=("Dictionary",),
    optionals=("Optional",),
)

_MODIFIERS = {
    "public",
    "private",
    "fileprivate",
    "internal",
    "open",
    "final",
    "static",
    "class",
    "lazy",
    "weak",
    "unowned",
    "override",
    "mutating",
    "nonmutating",
    "indirect",
    "required",
    "convenience",
    "dynamic",
    "nonisolated",
}
_OBSERVERS = re.compile(r"^\{\s*(willSet|didSet)\b")


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "aliases": {}, "warnings": []}

    def run(self) -> dict:
        cursor = self.cursor
        while not cursor.done:
            if not self._declaration():
                if cursor.is_("{"):
                    cursor.skip_group()
                else:
                    cursor.next()
        return self.declarations

    def _skip_attributes(self) -> None:
        cursor = self.cursor
        while cursor.is_("@") and cursor.is_ident(1):
            cursor.next()
            cursor.next()
            if cursor.is_("("):
                cursor.skip_group()

    def _declaration(self) -> bool:
        cursor = self.cursor
        start = cursor.index
        token = cursor.peek()
        doc = token.doc if token else None
        self._skip_attributes()
        while cursor.value() in _MODIFIERS and not (
            cursor.is_("class") and cursor.is_ident(1) and cursor.value(1) not in _MODIFIERS
        ):
            cursor.next()
        keyword = cursor.value()
        if keyword in ("struct", "class", "actor") and cursor.is_ident(1):
            cursor.next()
            self._type(keyword, doc)
            return True
        if keyword == "enum" and cursor.is_ident(1):
            cursor.next()
            self._enum(doc)
            return True
        if keyword == "typealias" and cursor.is_ident(1) and cursor.is_("=", 2):
            cursor.next()
            name = cursor.next().value
            cursor.next()
            type_ref = read_type(cursor, _SYNTAX)
            if type_ref:
                self.declarations["aliases"][name] = type_ref
            return True
        if keyword in ("protocol", "extension") and cursor.is_ident(1):
            while not cursor.done and not cursor.is_("{"):
                cursor.next()
            cursor.skip_group()
            return True
        cursor.index = start
        return False

    def _type(self, keyword: str, doc) -> None:
        cursor = self.cursor
        name = cursor.next().value
        generics: list[str] = []
        if cursor.is_("<"):
            cursor.next()
            while not cursor.done and not cursor.is_(">"):
                if cursor.is_ident() and cursor.tokens[cursor.index - 1].value in ("<", ","):
                    generics.append(cursor.value())
                cursor.next()
            cursor.eat(">")
        model = {
            "name": name,
            "kind": "struct" if keyword == "struct" else "class",
            "fields": [],
            "generics": generics,
            "construction": "named",
        }
        if doc:
            model["description"] = doc
        conformances: list[str] = []
        if cursor.eat(":"):
            while True:
                type_ref = read_type(cursor, _SYNTAX)
                if type_ref:
                    conformances.append(type_ref["name"])
                if not cursor.eat(","):
                    break
        while not cursor.done and not cursor.is_("{"):
            cursor.next()
        if any(item in ("Codable", "Decodable", "Encodable") for item in conformances):
            model["framework"] = "codable"
        # A class inherits from its first conformance when it is a class of the input
        model["extends"] = [conformances[0]] if keyword == "class" and conformances else []
        self.declarations["models"].append(model)
        model["fields"] = self._body()

    def _body(self) -> list[dict]:
        cursor = self.cursor
        fields: list[dict] = []
        coding_keys: dict[str, str] = {}
        if not cursor.eat("{"):
            return fields
        while not cursor.done and not cursor.is_("}"):
            if cursor.eat(";"):
                continue
            # CodingKeys: the names used in JSON
            if cursor.is_("enum") and cursor.is_("CodingKeys", 1):
                cursor.next()
                cursor.next()
                while not cursor.done and not cursor.is_("{"):
                    cursor.next()
                cursor.next()
                while not cursor.done and not cursor.is_("}"):
                    if cursor.eat("case"):
                        while True:
                            key = cursor.next().value
                            coding_keys[key] = cursor.next().value if cursor.eat("=") else key
                            if not cursor.eat(","):
                                break
                    else:
                        cursor.next()
                cursor.eat("}")
                continue
            member_start = cursor.index
            if self._declaration():
                continue
            cursor.index = member_start
            doc = cursor.peek().doc
            self._skip_attributes()
            modifiers: set[str] = set()
            while cursor.value() in _MODIFIERS or (cursor.is_("private") and cursor.is_("(", 1)):
                modifiers.add(cursor.next().value)
                # private(set) still exposes the getter
                if cursor.is_("("):
                    cursor.skip_group()
            if not (cursor.is_("let") or cursor.is_("var")):
                self._skip_member()
                continue
            is_let = cursor.next().value == "let"
            if not cursor.is_ident():
                self._skip_member()
                continue
            name = cursor.next().value
            type_ref = None
            type_text = None
            if cursor.eat(":"):
                type_start = cursor.index
                type_ref = read_type(cursor, _SYNTAX)
                type_text = cursor.text_between(self.source, type_start, cursor.index)
            default = None
            if cursor.eat("="):
                start = cursor.index
                self._skip_to_line_end()
                default = cursor.text_between(self.source, start, cursor.index)
            # var x: Int { … } is computed; { didSet { … } } observes a stored property
            computed = False
            if cursor.is_("{"):
                block_start = cursor.index
                cursor.skip_group()
                computed = not _OBSERVERS.match(cursor.text_between(self.source, block_start, cursor.index))
            if computed or modifiers & {"static", "class", "private", "fileprivate"}:
                continue
            field = {"name": name, "type": type_ref}
            if type_text:
                field["typeText"] = type_text
            if doc:
                field["description"] = doc
            if default is not None:
                literal = parse_literal(default)
                if literal is not MISSING:
                    field["defaultValue"] = literal
                # A let with a value is a constant: the memberwise initializer does not take it
                if is_let:
                    continue
                field["optional"] = True
                if not type_ref and literal is not MISSING and literal is not None:
                    if isinstance(literal, str):
                        inferred = "String"
                    elif isinstance(literal, bool):
                        inferred = "Bool"
                    else:
                        inferred = "Int" if isinstance(literal, int) else "Double"
                    field["type"] = raw(inferred)
            if not field["type"]:
                continue
            fields.append(field)
        cursor.eat("}")
        if coding_keys:
            # Only the properties listed in CodingKeys are encoded
            kept = [field for field in fields if field["name"] in coding_keys]
            for field in kept:
                wire = coding_keys[field["name"]]
                if wire != field["name"]:
                    field["serializedName"] = wire
            return kept
        return fields

    def _skip_to_line_end(self) -> None:
        cursor = self.cursor
        start = cursor.index
        depth = 0
        while not cursor.done:
            token = cursor.peek()
            if cursor.index > start and depth == 0 and (token.line_start or cursor.is_(";") or cursor.is_("}")):
                return
            if token.kind == "punct" and token.value in "([{":
                # A trailing { on the same line after the value is an accessor block only if a newline came first
                if token.value == "{" and depth == 0 and cursor.index > start:
                    return
                depth += 1
            elif token.kind == "punct" and token.value in ")]}":
                depth -= 1
            cursor.next()

    def _skip_member(self) -> None:
        cursor = self.cursor
        start = cursor.index
        while not cursor.done:
            if cursor.index > start and cursor.peek().line_start:
                return
            if cursor.is_("}"):
                return
            if cursor.is_("{") or cursor.is_("(") or cursor.is_("["):
                was_body = cursor.is_("{")
                cursor.skip_group()
                if was_body:
                    return
                continue
            cursor.next()

    def _enum(self, doc) -> None:
        cursor = self.cursor
        item = {"name": cursor.next().value, "values": []}
        if doc:
            item["description"] = doc
        raw_type = cursor.value() if cursor.eat(":") else ""
        while not cursor.done and not cursor.is_("{"):
            cursor.next()
        if not cursor.eat("{"):
            return
        following = 0
        while not cursor.done and not cursor.is_("}"):
            if not cursor.eat("case"):
                if cursor.is_("{"):
                    cursor.skip_group()
                elif self._declaration():
                    continue
                else:
                    cursor.next()
                continue
            while True:
                if not cursor.is_ident():
                    break
                value = {"name": cursor.next().value}
                if cursor.is_("("):
                    cursor.skip_group()
                if cursor.eat("="):
                    token = cursor.next()
                    if token.kind == "string":
                        value["value"] = token.value
                    elif token.kind == "number":
                        value["value"] = to_number(token.value)
                        following = value["value"] + 1 if value["value"] is not None else None
                elif raw_type == "Int":
                    value["value"] = following
                    following = following + 1 if following is not None else None
                item["values"].append(value)
                if not cursor.eat(","):
                    break
        cursor.eat("}")
        self.declarations["enums"].append(item)


_CODABLE = re.compile(r"\bstruct\s+\w+\s*:\s*[\w, ]*(Codable|Decodable|Encodable|Hashable|Identifiable)", re.ASCII)
_IMPORT = re.compile(r"^\s*import\s+(Foundation|SwiftUI|UIKit)\s*$", re.MULTILINE)
_PROPERTY = re.compile(r"\b(let|var)\s+\w+\s*:\s*\[?[A-Z]\w*\]?\??\s*$", re.MULTILINE | re.ASCII)
_TYPE = re.compile(r"\b(struct|class)\s+\w+", re.ASCII)
_DATA_CLASS = re.compile(r"\bdata\s+class\b")


def _detect(text: str) -> float:
    if _CODABLE.search(text):
        return 0.95
    if _IMPORT.search(text):
        return 0.95
    if _PROPERTY.search(text) and _TYPE.search(text) and not _DATA_CLASS.search(text):
        return 0.7
    return 0


def _parse(text: str, options: dict | None = None) -> dict:
    return parse_declarations(
        text, _LEXER, lambda source, tokens: _Reader(source, tokens).run(), SWIFT_TYPES, "swift", "swift"
    )


swift_parser = InputParser("swift", "code", "Swift", (".swift",), "swift", _detect, _parse)
