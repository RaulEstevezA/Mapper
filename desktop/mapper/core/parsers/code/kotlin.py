"""Kotlin classes, data classes and enums. Mirrors web/src/core/parsers/code/kotlin.ts."""

import re

from ...js import to_number
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
    strings=(
        StringRule('"""', '"""', False, True),
        StringRule('"', '"', True, False),
        StringRule("'", "'", True, False),
    ),
)

_SYNTAX = TypeSyntax(generics="<>", nullable_suffix=True)

KOTLIN_TYPES = TypeTable(
    primitives={
        "String": primitive("string"),
        "Char": primitive("string"),
        "Int": primitive("integer", 32),
        "UInt": primitive("integer", 32),
        "Long": primitive("integer", 64),
        "ULong": primitive("integer", 64),
        "Short": primitive("integer", 16),
        "Byte": primitive("integer", 8),
        "BigInteger": primitive("integer"),
        "Double": primitive("float", 64),
        "Float": primitive("float", 32),
        "BigDecimal": primitive("decimal"),
        "Boolean": primitive("boolean"),
        "LocalDate": primitive("date"),
        "LocalDateTime": primitive("datetime"),
        "OffsetDateTime": primitive("datetime"),
        "ZonedDateTime": primitive("datetime"),
        "Instant": primitive("datetime"),
        "Date": primitive("datetime"),
        "LocalTime": primitive("time"),
        "Duration": primitive("duration"),
        "UUID": primitive("uuid"),
        "Uuid": primitive("uuid"),
        "ByteArray": primitive("binary"),
        "Any": primitive("any"),
        "JsonElement": primitive("any"),
    },
    lists=(
        "List",
        "MutableList",
        "ArrayList",
        "Set",
        "MutableSet",
        "HashSet",
        "LinkedHashSet",
        "Collection",
        "Iterable",
        "Array",
        "Sequence",
    ),
    maps=("Map", "MutableMap", "HashMap", "LinkedHashMap"),
)

_MODIFIERS = {
    "data",
    "open",
    "abstract",
    "sealed",
    "inner",
    "private",
    "public",
    "internal",
    "protected",
    "override",
    "lateinit",
    "value",
    "inline",
    "const",
    "final",
    "external",
    "expect",
    "actual",
    "suspend",
    "operator",
    "infix",
    "tailrec",
    "vararg",
    "noinline",
    "crossinline",
}
_VARIANCE = ("in", "out", "reified")


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "aliases": {}, "warnings": []}
        self.namespace: str | None = None

    def _line_start(self) -> bool:
        token = self.cursor.peek()
        return token is not None and token.line_start

    def run(self) -> dict:
        cursor = self.cursor
        while not cursor.done:
            if cursor.is_("package") and self._line_start():
                cursor.next()
                name = ""
                while cursor.is_ident() or cursor.is_("."):
                    name += cursor.next().value
                    if self._line_start():
                        break
                self.namespace = name
                continue
            if cursor.is_("import") and self._line_start():
                cursor.next()
                while not cursor.done and not cursor.peek().line_start:
                    cursor.next()
                continue
            if cursor.is_("typealias") and cursor.is_ident(1):
                cursor.next()
                name = cursor.next().value
                if cursor.eat("="):
                    type_ref = read_type(cursor, _SYNTAX)
                    if type_ref:
                        self.declarations["aliases"][name] = type_ref
                continue
            if not self._declaration():
                cursor.next()
        return self.declarations

    def _annotations(self, annotations: list, modifiers: set, extra=lambda: False) -> None:
        cursor = self.cursor
        while True:
            if cursor.is_("@"):
                annotation = read_at_annotation(cursor, self.source)
                if annotation:
                    annotations.append(annotation)
                else:
                    cursor.next()
            elif cursor.value() in _MODIFIERS or extra():
                modifiers.add(cursor.next().value)
            else:
                return

    def _declaration(self) -> bool:
        cursor = self.cursor
        start = cursor.index
        token = cursor.peek()
        doc = token.doc if token else None
        annotations: list = []
        modifiers: set = set()
        self._annotations(
            annotations,
            modifiers,
            lambda: (cursor.is_("enum") or cursor.is_("annotation")) and cursor.is_("class", 1),
        )
        if cursor.is_("class") and cursor.is_ident(1):
            cursor.next()
            if "enum" in modifiers:
                self._enum(doc)
            elif "annotation" in modifiers:
                self._skip_declaration()
            else:
                self._class(modifiers, annotations, doc)
            return True
        if (cursor.is_("interface") or cursor.is_("object")) and (
            cursor.is_ident(1) or cursor.is_(":", 1) or cursor.is_("{", 1)
        ):
            cursor.next()
            self._skip_declaration()
            return True
        if cursor.is_("companion") and cursor.is_("object", 1):
            cursor.next()
            cursor.next()
            self._skip_declaration()
            return True
        cursor.index = start
        return False

    def _skip_declaration(self) -> None:
        cursor = self.cursor
        while (
            not cursor.done
            and not cursor.is_("{")
            and not cursor.is_("}")
            and not (cursor.peek().line_start and cursor.index > 0)
        ):
            cursor.next()
        if cursor.is_("{"):
            cursor.skip_group()

    def _type_parameters(self) -> list[str]:
        cursor = self.cursor
        names: list[str] = []
        if not cursor.is_("<"):
            return names
        depth = 0
        while True:
            token = cursor.next()
            before = cursor.at(cursor.index - 2)
            before_value = before.value if before else None
            if token.value == "<":
                depth += 1
            elif token.value == ">":
                depth -= 1
            elif depth == 1 and token.kind == "ident" and before_value in ("<", ",") and token.value not in _VARIANCE:
                names.append(token.value)
            elif depth == 1 and token.kind == "ident" and before_value in _VARIANCE:
                names.append(token.value)
            if cursor.done or depth <= 0:
                return names

    def _class(self, modifiers: set, annotations: list, doc) -> None:
        cursor = self.cursor
        name = cursor.next().value
        model = {
            "name": name,
            "kind": "class",
            "fields": [],
            "generics": self._type_parameters(),
            "construction": "properties",
        }
        if self.namespace:
            model["namespace"] = self.namespace
        if doc:
            model["description"] = doc
        if annotations:
            model["annotations"] = annotations
        if any(item["name"] == "Entity" for item in annotations):
            model["kind"] = "entity"
            model["framework"] = "jpa"
        if "data" in modifiers:
            model["kind"] = "entity" if model["kind"] == "entity" else "record"
        # A primary constructor, possibly after annotations and constructor
        while cursor.is_("@") or cursor.is_("constructor") or cursor.value() in _MODIFIERS:
            if cursor.is_("@"):
                read_at_annotation(cursor, self.source)
            else:
                cursor.next()
        if cursor.is_("("):
            model["fields"] = self._constructor_parameters()
            model["construction"] = "named"
        model["extends"] = []
        if cursor.eat(":"):
            while True:
                parent = read_type(cursor, _SYNTAX)
                if parent:
                    model["extends"].append(parent["name"].split(".")[-1])
                if cursor.is_("("):
                    cursor.skip_group()
                if cursor.eat("by"):
                    read_type(cursor, _SYNTAX)
                if not cursor.eat(","):
                    break
        # where T : Comparable<T> constraints
        if cursor.eat("where"):
            while not cursor.done and not cursor.is_("{") and not cursor.peek().line_start:
                cursor.next()
        self.declarations["models"].append(model)
        if cursor.is_("{"):
            model["fields"].extend(self._body())

    def _constructor_parameters(self) -> list[dict]:
        cursor = self.cursor
        fields: list[dict] = []
        cursor.next()
        while not cursor.done and not cursor.is_(")"):
            annotations = []
            is_property = False
            is_private = False
            while True:
                if cursor.is_("@"):
                    annotation = read_at_annotation(cursor, self.source)
                    if annotation:
                        annotations.append(annotation)
                    else:
                        cursor.next()
                elif cursor.is_("val") or cursor.is_("var"):
                    cursor.next()
                    is_property = True
                elif cursor.value() in _MODIFIERS and cursor.is_ident(1):
                    if cursor.next().value == "private":
                        is_private = True
                else:
                    break
            if not cursor.is_ident():
                cursor.skip_until([","])
                cursor.eat(",")
                continue
            name = cursor.next().value
            cursor.eat(":")
            type_start = cursor.index
            type_ref = read_type(cursor, _SYNTAX)
            field = {
                "name": name,
                "type": type_ref,
                "typeText": cursor.text_between(self.source, type_start, cursor.index),
            }
            if cursor.eat("="):
                start = cursor.index
                cursor.skip_until([","])
                literal = parse_literal(cursor.text_between(self.source, start, cursor.index))
                if literal is not MISSING:
                    field["defaultValue"] = literal
                field["optional"] = True
            if is_property and not is_private and apply_annotations(field, annotations):
                fields.append(field)
            cursor.eat(",")
        cursor.eat(")")
        return fields

    def _body(self) -> list[dict]:
        cursor = self.cursor
        fields: list[dict] = []
        cursor.next()
        while not cursor.done and not cursor.is_("}"):
            if cursor.eat(";"):
                continue
            member_start = cursor.index
            if self._declaration():
                continue
            cursor.index = member_start
            doc = cursor.peek().doc
            annotations: list = []
            modifiers: set = set()
            self._annotations(annotations, modifiers)
            if cursor.is_("init") and cursor.is_("{", 1):
                cursor.next()
                cursor.skip_group()
                continue
            if cursor.is_("fun") or cursor.is_("constructor"):
                self._skip_function()
                continue
            if not (cursor.is_("val") or cursor.is_("var")):
                self._skip_line()
                continue
            cursor.next()
            # Extension properties (val String.x) are not fields
            if not cursor.is_ident() or cursor.is_(".", 1):
                self._skip_line()
                continue
            name_token = cursor.next()
            type_ref = None
            type_text = None
            if cursor.eat(":"):
                type_start = cursor.index
                type_ref = read_type(cursor, _SYNTAX)
                type_text = cursor.text_between(self.source, type_start, cursor.index)
            field = {"name": name_token.value, "type": type_ref}
            if type_text:
                field["typeText"] = type_text
            if doc:
                field["description"] = doc
            computed = False
            if cursor.eat("="):
                start = cursor.index
                self._skip_line()
                literal = parse_literal(cursor.text_between(self.source, start, cursor.index))
                if literal is not MISSING:
                    field["defaultValue"] = literal
                if not type_ref and literal is not MISSING and literal is not None:
                    if isinstance(literal, str):
                        inferred = "String"
                    elif isinstance(literal, bool):
                        inferred = "Boolean"
                    elif isinstance(literal, int):
                        inferred = "Int"
                    else:
                        inferred = "Double"
                    field["type"] = raw(inferred)
            elif cursor.eat("by"):
                computed = True
                self._skip_line()
            # A custom getter (val full get() = …) computes the value
            if cursor.is_("get") and (cursor.is_("(", 1) or cursor.is_("=", 1)):
                computed = True
                self._skip_function()
            if cursor.is_("private") and cursor.is_("set", 1):
                cursor.next()
                cursor.next()
            if computed or "private" in modifiers or "const" in modifiers or not field["type"]:
                continue
            if apply_annotations(field, annotations):
                fields.append(field)
        cursor.eat("}")
        return fields

    def _skip_line(self) -> None:
        """Skips to the start of the next line (outside brackets) or the closing brace of the body."""
        cursor = self.cursor
        start = cursor.index
        depth = 0
        while not cursor.done:
            token = cursor.peek()
            if cursor.index > start and depth == 0 and token.line_start:
                return
            if token.kind == "punct":
                if token.value in "([{":
                    depth += 1
                elif token.value in ")]}":
                    if depth == 0:
                        return
                    depth -= 1
            cursor.next()

    def _skip_function(self) -> None:
        cursor = self.cursor
        while not cursor.done and not cursor.is_("("):
            cursor.next()
        cursor.skip_group()
        if cursor.eat(":"):
            read_type(cursor, _SYNTAX)
        if cursor.is_("{"):
            cursor.skip_group()
        elif cursor.eat("="):
            self._skip_line()

    def _enum(self, doc) -> None:
        cursor = self.cursor
        item = {"name": cursor.next().value, "values": []}
        if self.namespace:
            item["namespace"] = self.namespace
        if doc:
            item["description"] = doc
        if cursor.is_("("):
            cursor.skip_group()
        while not cursor.done and not cursor.is_("{"):
            cursor.next()
        if not cursor.eat("{"):
            return
        while not cursor.done and not cursor.is_("}") and not cursor.is_(";"):
            while cursor.is_("@"):
                read_at_annotation(cursor, self.source)
            if not cursor.is_ident():
                cursor.next()
                continue
            value = {"name": cursor.next().value}
            if cursor.is_("("):
                first = cursor.peek(1)
                if first is not None and first.kind == "string":
                    value["value"] = first.value
                elif first is not None and first.kind == "number":
                    value["value"] = to_number(first.value)
                cursor.skip_group()
            if cursor.is_("{"):
                cursor.skip_group()
            item["values"].append(value)
            cursor.eat(",")
        depth = 1
        while not cursor.done and depth > 0:
            token = cursor.next()
            if token.kind != "punct":
                continue
            if token.value == "{":
                depth += 1
            elif token.value == "}":
                depth -= 1
        self.declarations["enums"].append(item)


_DATA_CLASS = re.compile(r"\bdata\s+class\s+\w+", re.ASCII)
_PROPERTY = re.compile(r"\b(val|var)\s+\w+\s*:\s*[\w<>?, ]+", re.ASCII)
_CLASS = re.compile(r"\bclass\s+\w+", re.ASCII)
_STATEMENT = re.compile(r";\s*$", re.MULTILINE)
_ENUM_CLASS = re.compile(r"\benum\s+class\s+\w+", re.ASCII)


def _detect(text: str) -> float:
    if _DATA_CLASS.search(text):
        return 0.95
    if _PROPERTY.search(text) and _CLASS.search(text) and not _STATEMENT.search(text):
        return 0.8
    if _ENUM_CLASS.search(text):
        return 0.8
    return 0


def _parse(text: str, options: dict | None = None) -> dict:
    return parse_declarations(
        text, _LEXER, lambda source, tokens: _Reader(source, tokens).run(), KOTLIN_TYPES, "kotlin", "kotlin"
    )


kotlin_parser = InputParser("kotlin", "code", "Kotlin", (".kt", ".kts"), "kotlin", _detect, _parse)
