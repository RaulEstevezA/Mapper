"""Protocol Buffers messages and enums. Mirrors web/src/core/parsers/schema/protobuf.ts."""

import re

from ...js import to_number, trim
from ...model.schema import primitive
from ..code.lexer import C_LIKE, Cursor, LexError, tokenize
from ..code.raw import TypeTable, build_schema, raw
from ..types import InputParser, failure, position_at

PROTOBUF_TYPES = TypeTable(
    primitives={
        "string": primitive("string"),
        "bytes": primitive("binary"),
        "bool": primitive("boolean"),
        "double": primitive("float", 64),
        "float": primitive("float", 32),
        "int32": primitive("integer", 32),
        "sint32": primitive("integer", 32),
        "sfixed32": primitive("integer", 32),
        "uint32": primitive("integer", 32),
        "fixed32": primitive("integer", 32),
        "int64": primitive("integer", 64),
        "sint64": primitive("integer", 64),
        "sfixed64": primitive("integer", 64),
        "uint64": primitive("integer", 64),
        "fixed64": primitive("integer", 64),
        "google.protobuf.Timestamp": primitive("datetime"),
        "google.protobuf.Duration": primitive("duration"),
        "google.protobuf.Any": primitive("any"),
        "google.protobuf.Struct": primitive("any"),
        "google.protobuf.Value": primitive("any"),
        "google.type.Date": primitive("date"),
        "google.type.Money": primitive("decimal"),
    },
    # Wrapper types exist to make a scalar nullable
    nullable_primitives={
        "google.protobuf.StringValue": primitive("string"),
        "google.protobuf.BytesValue": primitive("binary"),
        "google.protobuf.BoolValue": primitive("boolean"),
        "google.protobuf.DoubleValue": primitive("float", 64),
        "google.protobuf.FloatValue": primitive("float", 32),
        "google.protobuf.Int32Value": primitive("integer", 32),
        "google.protobuf.UInt32Value": primitive("integer", 32),
        "google.protobuf.Int64Value": primitive("integer", 64),
        "google.protobuf.UInt64Value": primitive("integer", 64),
    },
)

_SCALARS = {name for name in PROTOBUF_TYPES.primitives if "." not in name}


class _Reader:
    def __init__(self, tokens: list):
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "warnings": []}
        self.proto3 = False
        self.namespace: str | None = None
        # Enums declared anywhere in the file, also after the messages that use them
        self.enum_names = {
            token.value
            for index, token in enumerate(tokens)
            if index > 0 and tokens[index - 1].value == "enum" and token.kind == "ident"
        }

    def _previous_doc(self):
        cursor = self.cursor
        return cursor.tokens[cursor.index - 1].doc if 0 < cursor.index <= len(cursor.tokens) else None

    def _qualified_name(self) -> str:
        cursor = self.cursor
        # A leading dot means a fully qualified name (.google.protobuf.Timestamp)
        cursor.eat(".")
        name = cursor.next().value
        while cursor.is_(".") and cursor.is_ident(1):
            cursor.next()
            name += f".{cursor.next().value}"
        return name

    def _skip_block(self) -> None:
        cursor = self.cursor
        while not cursor.done and not cursor.is_("{"):
            cursor.next()
        cursor.skip_group()

    def _skip_statement(self) -> None:
        self.cursor.skip_until([";"])
        self.cursor.eat(";")

    def run(self) -> None:
        cursor = self.cursor
        while not cursor.done:
            if cursor.is_("syntax") or cursor.is_("edition"):
                cursor.next()
                cursor.eat("=")
                value = cursor.value()
                self.proto3 = value == "proto3" or value != "proto2"
                self._skip_statement()
            elif cursor.is_("package"):
                cursor.next()
                self.namespace = self._qualified_name()
                cursor.eat(";")
            elif cursor.is_("message") and cursor.is_ident(1):
                cursor.next()
                self._message()
            elif cursor.is_("enum") and cursor.is_ident(1):
                cursor.next()
                self._enum()
            elif cursor.is_("service") or cursor.is_("extend"):
                self._skip_block()
            elif cursor.is_("{"):
                cursor.skip_group()
            else:
                cursor.next()

    def _message(self) -> None:
        cursor = self.cursor
        token = cursor.peek()
        doc = token.doc if token and token.doc is not None else self._previous_doc()
        model = {"name": cursor.next().value, "kind": "message", "fields": [], "construction": "properties"}
        if self.namespace:
            model["namespace"] = self.namespace
        if doc:
            model["description"] = doc
        self.declarations["models"].append(model)
        if cursor.eat("{"):
            self._fields(model)

    def _fields(self, model: dict, in_oneof: bool = False) -> None:
        cursor = self.cursor
        while not cursor.done and not cursor.is_("}"):
            if cursor.eat(";"):
                continue
            if cursor.is_("message") and cursor.is_ident(1):
                cursor.next()
                self._message()
                continue
            if cursor.is_("enum") and cursor.is_ident(1):
                cursor.next()
                self._enum()
                continue
            if cursor.is_("oneof") and cursor.is_ident(1):
                # Only one field of a oneof is set: all of them are optional
                cursor.next()
                cursor.next()
                cursor.eat("{")
                self._fields(model, True)
                continue
            if cursor.value() in ("option", "reserved", "extensions", "extend"):
                if cursor.is_("extend"):
                    self._skip_block()
                else:
                    self._skip_statement()
                continue
            doc = cursor.peek().doc
            label = ""
            if cursor.value() in ("optional", "repeated", "required") and (cursor.is_ident(1) or cursor.is_(".", 1)):
                label = cursor.next().value
            if cursor.is_("map") and cursor.is_("<", 1):
                cursor.next()
                cursor.next()
                key = self._qualified_name()
                cursor.eat(",")
                value = self._qualified_name()
                cursor.eat(">")
                type_ref = raw("{}", [raw(key), raw(value)])
            elif cursor.is_ident() or cursor.is_("."):
                type_name = self._qualified_name()
                # References to nested messages may be qualified (Order.Line): the last part names the model
                keep = type_name in _SCALARS or type_name.startswith("google.")
                type_ref = raw(type_name if keep else type_name.split(".")[-1])
            else:
                cursor.next()
                continue
            if not cursor.is_ident():
                self._skip_statement()
                continue
            name = cursor.next().value
            deprecated = False
            cursor.skip_until([";", "["])
            if cursor.is_("["):
                start = cursor.index
                cursor.skip_group()
                deprecated = any(token.value == "deprecated" for token in cursor.tokens[start : cursor.index])
            cursor.eat(";")
            if label == "repeated":
                type_ref = raw("[]", [type_ref])
            is_scalar = type_ref["name"] in _SCALARS or type_ref["name"] in ("{}", "[]")
            field = {"name": name, "type": type_ref}
            # proto3: scalars always have a value (their default); messages and optional fields may be absent
            if label == "optional" or in_oneof or (not self.proto3 and label != "required"):
                field["optional"] = True
                field["nullable"] = True
            elif not is_scalar and type_ref["name"] not in self.enum_names:
                field["optional"] = True
                field["nullable"] = True
            if doc:
                field["description"] = doc
            if deprecated:
                field["metadata"] = {"deprecated": True}
            model["fields"].append(field)
        cursor.eat("}")

    def _enum(self) -> None:
        cursor = self.cursor
        doc = self._previous_doc()
        item = {"name": cursor.next().value, "values": []}
        if doc:
            item["description"] = doc
        if not cursor.eat("{"):
            return
        while not cursor.done and not cursor.is_("}"):
            if cursor.is_("option") or cursor.is_("reserved"):
                self._skip_statement()
                continue
            if cursor.is_ident() and cursor.is_("=", 1):
                value_name = cursor.next().value
                cursor.next()
                negative = cursor.eat("-")
                number = to_number(cursor.next().value)
                item["values"].append(
                    {"name": value_name, "value": -number if negative and number is not None else number}
                )
                self._skip_statement()
                continue
            cursor.next()
        cursor.eat("}")
        self.declarations["enums"].append(item)


_SYNTAX = re.compile(r"^\s*syntax\s*=\s*[\"']proto[23][\"']", re.MULTILINE)
_MESSAGE = re.compile(r"^\s*message\s+\w+\s*\{", re.MULTILINE | re.ASCII)
_NUMBERED = re.compile(r"=\s*[0-9]+\s*;")


def _detect(text: str) -> float:
    if _SYNTAX.search(text):
        return 0.99
    return 0.9 if _MESSAGE.search(text) and _NUMBERED.search(text) else 0


def _parse(text: str, options: dict | None = None) -> dict:
    if trim(text) == "":
        return failure("empty")
    try:
        tokens = tokenize(text, C_LIKE)
    except LexError as error:
        return failure(error.code, position_at(text, error.index))
    reader = _Reader(tokens)
    reader.run()
    if not reader.declarations["models"]:
        return failure("noModels")
    built = build_schema(reader.declarations, PROTOBUF_TYPES, "protobuf", "protobuf")
    return {"ok": True, "schema": built["schema"], "warnings": built["warnings"]}


protobuf_parser = InputParser("protobuf", "schema", "Protocol Buffers", (".proto",), "protobuf", _detect, _parse)
