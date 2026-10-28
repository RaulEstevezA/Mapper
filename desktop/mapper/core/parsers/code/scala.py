"""Scala case classes, sealed traits with case objects and Scala 3 enums. Mirrors
web/src/core/parsers/code/scala.ts."""

import re

from ...model.schema import primitive
from ..types import InputParser
from .annotations import apply_annotations, read_at_annotation
from .lexer import Cursor, LexerConfig, StringRule
from .raw import MISSING, TypeTable, parse_declarations, parse_literal, raw
from .type_syntax import TypeSyntax, read_type

_LEXER = LexerConfig(
    line_comments=("//",),
    block_comments=(("/*", "*/"),),
    nested_comments=True,
    strings=(StringRule('"""', '"""', False, True), StringRule('"', '"', True, False)),
    string_prefixes=re.compile(r"^[sf]"),
)

_SYNTAX = TypeSyntax(generics="[]")

SCALA_TYPES = TypeTable(
    primitives={
        "String": primitive("string"),
        "Char": primitive("string"),
        "Int": primitive("integer", 32),
        "Long": primitive("integer", 64),
        "Short": primitive("integer", 16),
        "Byte": primitive("integer", 8),
        "BigInt": primitive("integer"),
        "Double": primitive("float", 64),
        "Float": primitive("float", 32),
        "BigDecimal": primitive("decimal"),
        "Boolean": primitive("boolean"),
        "LocalDate": primitive("date"),
        "LocalDateTime": primitive("datetime"),
        "OffsetDateTime": primitive("datetime"),
        "ZonedDateTime": primitive("datetime"),
        "Instant": primitive("datetime"),
        "LocalTime": primitive("time"),
        "Duration": primitive("duration"),
        "UUID": primitive("uuid"),
        "Json": primitive("any"),
        "JsValue": primitive("any"),
        "Any": primitive("any"),
    },
    lists=("List", "Seq", "Vector", "Set", "IndexedSeq", "Iterable", "Array", "ArraySeq"),
    maps=("Map",),
    optionals=("Option",),
)

_MODIFIERS = {"final", "sealed", "abstract", "private", "protected", "implicit", "lazy", "override", "open", "case"}


def _normalize(type_ref):
    if not type_ref:
        return None
    # Array[Byte] is binary data
    if type_ref["name"] == "Array" and type_ref["args"] and type_ref["args"][0]["name"] == "Byte":
        return raw("Json")
    return type_ref


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "aliases": {}, "warnings": []}
        # sealed trait Status + case object Active extends Status: an enum
        self.sealed_traits: dict[str, dict] = {}
        self.namespace: str | None = None

    def _annotations(self) -> list[dict]:
        cursor = self.cursor
        annotations: list[dict] = []
        while cursor.is_("@"):
            annotation = read_at_annotation(cursor, self.source)
            if annotation:
                annotations.append(annotation)
            else:
                cursor.next()
        return annotations

    def run(self) -> dict:
        cursor = self.cursor
        while not cursor.done:
            if cursor.is_("package") and cursor.is_ident(1):
                cursor.next()
                name = cursor.next().value
                while cursor.is_(".") and cursor.is_ident(1):
                    cursor.next()
                    name += f".{cursor.next().value}"
                self.namespace = name
                continue
            if cursor.is_("import"):
                line = cursor.next().line
                while not cursor.done and cursor.peek().line == line:
                    cursor.next()
                continue
            doc = cursor.peek().doc
            annotations = self._annotations()
            start = cursor.index
            modifiers: set[str] = set()
            while cursor.value() in _MODIFIERS and (cursor.is_ident(1) or cursor.is_("class", 1)):
                modifiers.add(cursor.next().value)
            if cursor.is_("class") and cursor.is_ident(1):
                cursor.next()
                self._class("case" in modifiers, annotations, doc)
            elif cursor.is_("enum") and cursor.is_ident(1):
                cursor.next()
                self._enum(doc)
            elif cursor.is_("trait") and cursor.is_ident(1) and "sealed" in modifiers:
                cursor.next()
                name = cursor.next().value
                item = {"name": name, "values": []}
                if doc:
                    item["description"] = doc
                self.sealed_traits[name] = item
                if cursor.is_("{"):
                    cursor.skip_group()
            elif cursor.is_("object") and cursor.is_ident(1) and "case" in modifiers:
                # case object Active extends Status
                cursor.next()
                name = cursor.next().value
                if cursor.eat("extends") and cursor.is_ident():
                    trait = self.sealed_traits.get(cursor.value())
                    if trait is not None:
                        trait["values"].append({"name": name})
                if cursor.is_("{"):
                    cursor.skip_group()
            elif cursor.is_("type") and cursor.is_ident(1) and cursor.is_("=", 2):
                cursor.next()
                name = cursor.next().value
                cursor.next()
                type_ref = _normalize(read_type(cursor, _SYNTAX))
                if type_ref:
                    self.declarations["aliases"][name] = type_ref
            elif cursor.index == start:
                if cursor.is_("{") or cursor.is_("("):
                    cursor.skip_group()
                else:
                    cursor.next()
        for item in self.sealed_traits.values():
            if item["values"]:
                self.declarations["enums"].append(item)
        return self.declarations

    def _class(self, is_case: bool, annotations: list[dict], doc) -> None:
        cursor = self.cursor
        name = cursor.next().value
        generics: list[str] = []
        if cursor.is_("["):
            cursor.next()
            while not cursor.done and not cursor.is_("]"):
                if cursor.is_ident() and cursor.tokens[cursor.index - 1].value in ("[", ","):
                    generics.append(cursor.value())
                cursor.next()
            cursor.eat("]")
        fields: list[dict] = []
        if cursor.is_("("):
            cursor.next()
            while not cursor.done and not cursor.is_(")"):
                field_annotations = self._annotations()
                is_private = cursor.is_("private")
                while cursor.value() in ("val", "var", "private", "protected", "override", "implicit"):
                    cursor.next()
                if not cursor.is_ident() or not cursor.is_(":", 1):
                    cursor.skip_until([","])
                    cursor.eat(",")
                    continue
                field_name = cursor.next().value
                cursor.next()
                type_start = cursor.index
                type_ref = _normalize(read_type(cursor, _SYNTAX))
                field = {
                    "name": field_name,
                    "type": type_ref,
                    "typeText": cursor.text_between(self.source, type_start, cursor.index),
                }
                if cursor.eat("="):
                    start = cursor.index
                    cursor.skip_until([","])
                    text = cursor.text_between(self.source, start, cursor.index)
                    literal = parse_literal("null" if text == "None" else text)
                    if literal is not MISSING:
                        field["defaultValue"] = literal
                    field["optional"] = True
                if type_ref and type_ref["name"] == "Option":
                    field.setdefault("optional", False)
                if not is_private and apply_annotations(field, field_annotations):
                    fields.append(field)
                cursor.eat(",")
            cursor.eat(")")
        # extends, derives and the body are not data
        while not cursor.done and not cursor.peek().line_start and not cursor.is_("{"):
            cursor.next()
        if cursor.is_("{"):
            cursor.skip_group()
        model = {
            "name": name,
            "kind": "record" if is_case else "class",
            "fields": fields,
            "generics": generics,
            "construction": "named",
        }
        if self.namespace:
            model["namespace"] = self.namespace
        if doc:
            model["description"] = doc
        if annotations:
            model["annotations"] = annotations
        self.declarations["models"].append(model)

    def _enum(self, doc) -> None:
        """Scala 3: enum Status { case Active, Blocked } or with an indented body (enum Status:)."""
        cursor = self.cursor
        item = {"name": cursor.next().value, "values": []}
        if doc:
            item["description"] = doc
        if cursor.is_("("):
            cursor.skip_group()
        braces = cursor.eat("{")
        if not braces:
            cursor.eat(":")
        token = cursor.peek()
        column = token.column if token else 0

        def at_end() -> bool:
            if braces:
                return cursor.is_("}")
            current = cursor.peek()
            return current.line_start and current.column < column

        while not cursor.done and not at_end():
            if cursor.eat("case"):
                while True:
                    if not cursor.is_ident():
                        break
                    item["values"].append({"name": cursor.next().value})
                    if cursor.is_("("):
                        cursor.skip_group()
                    if cursor.is_("extends"):
                        while not cursor.done and not cursor.peek().line_start and not cursor.is_(","):
                            cursor.next()
                    if not cursor.eat(","):
                        break
            elif cursor.is_("{"):
                cursor.skip_group()
            else:
                cursor.next()
        if braces:
            cursor.eat("}")
        self.declarations["enums"].append(item)


_CASE_CLASS = re.compile(r"\bcase\s+class\s+\w+", re.ASCII)
_SEALED_TRAIT = re.compile(r"\bsealed\s+trait\s+\w+", re.ASCII)
_ENUM = re.compile(r"^\s*enum\s+\w+\s*(:|\{)", re.MULTILINE | re.ASCII)
_CASE = re.compile(r"\bcase\s+\w+", re.ASCII)


def _detect(text: str) -> float:
    if _CASE_CLASS.search(text):
        return 0.95
    if _SEALED_TRAIT.search(text) or (_ENUM.search(text) and _CASE.search(text)):
        return 0.8
    return 0


def _parse(text: str, options: dict | None = None) -> dict:
    return parse_declarations(
        text, _LEXER, lambda source, tokens: _Reader(source, tokens).run(), SCALA_TYPES, "scala", "scala"
    )


scala_parser = InputParser("scala", "code", "Scala", (".scala", ".sc"), "scala", _detect, _parse)
