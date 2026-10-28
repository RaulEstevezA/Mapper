"""GraphQL schemas (SDL). Mirrors web/src/core/parsers/schema/graphql.ts."""

import re

from ...js import json_string, trim
from ...model.schema import primitive
from ..code.lexer import Cursor, LexerConfig, LexError, StringRule, tokenize
from ..code.raw import MISSING, TypeTable, build_schema, parse_literal, raw
from ..types import InputParser, failure, position_at

_LEXER = LexerConfig(
    line_comments=("#",),
    strings=(StringRule('"""', '"""', False, True), StringRule('"', '"', True, False)),
)

GRAPHQL_TYPES = TypeTable(
    primitives={
        "ID": primitive("string"),
        "String": primitive("string"),
        "Int": primitive("integer", 32),
        "Float": primitive("float", 64),
        "Boolean": primitive("boolean"),
        # Custom scalars with a conventional meaning
        "DateTime": primitive("datetime"),
        "Timestamp": primitive("datetime"),
        "Date": primitive("date"),
        "Time": primitive("time"),
        "UUID": primitive("uuid"),
        "Long": primitive("integer", 64),
        "BigInt": primitive("integer"),
        "Decimal": primitive("decimal"),
        "BigDecimal": primitive("decimal"),
        "JSON": primitive("any"),
        "JSONObject": primitive("any"),
        "Upload": primitive("binary"),
        "Email": primitive("string"),
        "URL": primitive("string"),
    }
)


def _read_type(cursor: Cursor):
    """GraphQL types are nullable unless marked with !; lists are [T]."""
    if cursor.eat("["):
        items = _read_type(cursor)
        cursor.eat("]")
        type_ref = raw("[]", [items] if items else [])
    elif cursor.is_ident():
        type_ref = raw(cursor.next().value)
    else:
        return None
    if cursor.eat("!"):
        return type_ref
    return {**type_ref, "nullable": True}


def _skip_directives(cursor: Cursor) -> None:
    while cursor.is_("@") and cursor.is_ident(1):
        cursor.next()
        cursor.next()
        if cursor.is_("("):
            cursor.skip_group()


def _previous_doc(cursor: Cursor):
    return cursor.tokens[cursor.index - 1].doc if cursor.index > 0 else None


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "aliases": {}, "warnings": []}

    def run(self) -> None:
        cursor = self.cursor
        while not cursor.done:
            # A description is a string right before the definition
            description = None
            if cursor.peek().kind == "string":
                description = trim(cursor.next().value)
            extend = cursor.eat("extend")
            keyword = cursor.value()
            if keyword in ("type", "input", "interface") and cursor.is_ident(1):
                cursor.next()
                self._object_type(keyword, extend, description if description is not None else _previous_doc(cursor))
            elif keyword == "enum" and cursor.is_ident(1):
                cursor.next()
                self._enum_type(description)
            elif keyword == "scalar" and cursor.is_ident(1):
                cursor.next()
                name = cursor.next().value
                # A scalar the table does not know is text on the wire
                if name not in GRAPHQL_TYPES.primitives:
                    self.declarations["aliases"][name] = raw("String")
                _skip_directives(cursor)
            elif cursor.is_("{") or cursor.is_("("):
                cursor.skip_group()
            else:
                cursor.next()

    def _object_type(self, keyword: str, extend: bool, description) -> None:
        cursor = self.cursor
        name = cursor.next().value
        # The operation roots describe the API, not data
        is_root = name in ("Query", "Mutation", "Subscription")
        parents: list[str] = []
        if cursor.eat("implements"):
            cursor.eat("&")
            while cursor.is_ident():
                parents.append(cursor.next().value)
                if not cursor.eat("&") and not cursor.eat(","):
                    break
        _skip_directives(cursor)
        existing = next((model for model in self.declarations["models"] if model["name"] == name), None)
        if extend and existing:
            model = existing
        else:
            kind = "input" if keyword == "input" else "interface" if keyword == "interface" else "object"
            model = {"name": name, "kind": kind, "fields": []}
        if not existing or not extend:
            if description:
                model["description"] = description
            if parents:
                model["extends"] = parents
        if not cursor.eat("{"):
            return
        while not cursor.done and not cursor.is_("}"):
            field_description = None
            if cursor.peek().kind == "string":
                field_description = trim(cursor.next().value)
            if not cursor.is_ident():
                cursor.next()
                continue
            name_token = cursor.next()
            # Fields with arguments are resolvers: they compute a value from the arguments
            has_arguments = cursor.is_("(")
            if has_arguments:
                cursor.skip_group()
            cursor.eat(":")
            type_start = cursor.index
            type_ref = _read_type(cursor)
            field = {
                "name": name_token.value,
                "type": type_ref,
                "typeText": cursor.text_between(self.source, type_start, cursor.index),
            }
            if cursor.eat("="):
                token = cursor.next()
                literal = parse_literal(json_string(token.value) if token.kind == "string" else token.value)
                # An enum value (role: Role = MEMBER) is written as a bare name
                if literal is not MISSING:
                    field["defaultValue"] = literal
                elif token.kind == "ident":
                    field["defaultValue"] = token.value
            _skip_directives(cursor)
            doc = field_description if field_description is not None else name_token.doc
            if doc:
                field["description"] = doc
            if has_arguments:
                field["metadata"] = {"arguments": True}
            model["fields"].append(field)
        cursor.eat("}")
        if not is_root and not (extend and existing):
            self.declarations["models"].append(model)

    def _enum_type(self, description) -> None:
        cursor = self.cursor
        name = cursor.next().value
        _skip_directives(cursor)
        values = []
        if cursor.eat("{"):
            while not cursor.done and not cursor.is_("}"):
                value_description = None
                if cursor.peek().kind == "string":
                    value_description = trim(cursor.next().value)
                if cursor.is_ident():
                    value = {"name": cursor.next().value}
                    if value_description:
                        value["description"] = value_description
                    values.append(value)
                else:
                    cursor.next()
                _skip_directives(cursor)
            cursor.eat("}")
        item = {"name": name, "values": values}
        if description:
            item["description"] = description
        self.declarations["enums"].append(item)


# TypeScript writes its types in lower case (string, number); GraphQL in capitals (String, Int)
_TS_TYPES = re.compile(r":\s*(string|number|boolean|unknown|any)\b")
_EXPORT = re.compile(r"\bexport\s")
_TYPE_BLOCK = re.compile(
    r"^\s*(extend\s+)?(type|input|interface)\s+\w+(\s+implements\s+[\w&\s]+)?\s*(@\w+(\([^)]*\))?\s*)*\{",
    re.MULTILINE | re.ASCII,
)
_FIELD = re.compile(r":\s*\[?\w+!?\]?!?", re.ASCII)
_STATEMENT_END = re.compile(r"[;=]\s*$", re.MULTILINE)
_SCALAR = re.compile(r"^\s*(scalar|enum)\s+\w+", re.MULTILINE | re.ASCII)
_TYPE = re.compile(r"^\s*type\s+\w+", re.MULTILINE | re.ASCII)


def _detect(text: str) -> float:
    if _TS_TYPES.search(text) or _EXPORT.search(text):
        return 0
    if _TYPE_BLOCK.search(text) and _FIELD.search(text) and not _STATEMENT_END.search(text):
        return 0.9
    if _SCALAR.search(text) and _TYPE.search(text):
        return 0.7
    return 0


def _parse(text: str, options: dict | None = None) -> dict:
    if trim(text) == "":
        return failure("empty")
    try:
        tokens = tokenize(text, _LEXER)
    except LexError as error:
        return failure(error.code, position_at(text, error.index))
    reader = _Reader(text, tokens)
    reader.run()
    if not reader.declarations["models"]:
        return failure("noModels")
    built = build_schema(reader.declarations, GRAPHQL_TYPES, "graphql", "graphql")
    return {"ok": True, "schema": built["schema"], "warnings": built["warnings"]}


graphql_parser = InputParser(
    "graphql", "schema", "GraphQL", (".graphql", ".graphqls", ".gql"), "graphql", _detect, _parse
)
