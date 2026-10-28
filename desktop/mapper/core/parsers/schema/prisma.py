"""Prisma schemas: models, views, composite types and enums. Mirrors web/src/core/parsers/schema/prisma.ts."""

import re

from ...js import coalesce, trim
from ...model.schema import primitive
from ..code.annotations import annotation_arg
from ..code.lexer import C_LIKE, Cursor, LexError, tokenize
from ..code.raw import MISSING, TypeTable, build_schema, parse_literal, raw
from ..types import InputParser, failure, position_at

PRISMA_TYPES = TypeTable(
    primitives={
        "String": primitive("string"),
        "Int": primitive("integer", 32),
        "BigInt": primitive("integer", 64),
        "Float": primitive("float", 64),
        "Decimal": primitive("decimal"),
        "Boolean": primitive("boolean"),
        "DateTime": primitive("datetime"),
        "Json": primitive("any"),
        "Bytes": primitive("binary"),
        "Unsupported": primitive("any"),
    }
)

# Defaults computed by the database or Prisma: the value is never needed from a mapping
_GENERATED_DEFAULTS = re.compile(r"(autoincrement|now|uuid|cuid|nanoid|ulid|dbgenerated|sequence)\(")
_WORD = re.compile(r"\w+", re.ASCII)


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "aliases": {}, "warnings": []}

    def run(self) -> None:
        cursor = self.cursor
        while not cursor.done:
            if (
                (cursor.is_("model") or cursor.is_("view") or cursor.is_("type"))
                and cursor.is_ident(1)
                and cursor.is_("{", 2)
            ):
                cursor.next()
                self._model()
            elif cursor.is_("enum") and cursor.is_ident(1):
                cursor.next()
                self._enum()
            elif cursor.is_("{"):
                cursor.skip_group()
            else:
                cursor.next()

    def _model(self) -> None:
        cursor = self.cursor
        doc = cursor.tokens[cursor.index - 1].doc if cursor.index > 0 else None
        model = {
            "name": cursor.next().value,
            "kind": "table",
            "fields": [],
            "framework": "prisma",
            "construction": "named",
        }
        if doc:
            model["description"] = doc
        cursor.next()
        while not cursor.done and not cursor.is_("}"):
            if cursor.is_("@") and cursor.is_("@", 1):
                # Block attributes (@@map, @@id, @@index)
                line = cursor.peek().line
                while not cursor.done and cursor.peek().line == line and not cursor.is_("}"):
                    cursor.next()
                continue
            if not cursor.is_ident():
                cursor.next()
                continue
            field_index = cursor.index
            field_token = cursor.next()
            line = field_token.line
            if not cursor.is_ident():
                continue
            type_ref = raw(cursor.next().value)
            if cursor.is_("(") and type_ref["name"] == "Unsupported":
                cursor.skip_group()
            if cursor.is_("[") and cursor.is_("]", 1):
                cursor.next()
                cursor.next()
                type_ref = raw("[]", [type_ref])
            field = {
                "name": field_token.value,
                "type": type_ref,
                "typeText": cursor.text_between(self.source, field_index + 1, cursor.index),
            }
            if cursor.eat("?"):
                field["nullable"] = True
            # Field attributes until the end of the line
            while not cursor.done and cursor.peek().line == line and not cursor.is_("}"):
                if cursor.is_("@") and cursor.is_ident(1):
                    cursor.next()
                    attribute = cursor.next().value
                    while cursor.is_(".") and cursor.is_ident(1):
                        cursor.next()
                        attribute += f".{cursor.next().value}"
                    args = ""
                    if cursor.is_("("):
                        start = cursor.index
                        cursor.skip_group()
                        args = trim(cursor.text_between(self.source, start, cursor.index)[1:-1])
                    field["annotations"] = [*field.get("annotations", []), {"name": attribute, "args": args}]
                    if attribute == "default":
                        field["optional"] = True
                        if _GENERATED_DEFAULTS.match(args):
                            field["generated"] = True
                        else:
                            literal = parse_literal(args)
                            if literal is not MISSING:
                                field["defaultValue"] = literal
                            elif _WORD.fullmatch(args):
                                field["defaultValue"] = args
                    if attribute == "updatedAt":
                        field["generated"] = True
                    if attribute == "map":
                        annotation = {"name": "map", "args": args}
                        column = coalesce(annotation_arg(annotation, None), annotation_arg(annotation, "name"))
                        if column:
                            field["serializedName"] = column
                    if attribute == "relation":
                        field["metadata"] = {"relation": True}
                else:
                    cursor.next()
            if field_token.doc:
                field["description"] = field_token.doc
            model["fields"].append(field)
        cursor.eat("}")
        self.declarations["models"].append(model)

    def _enum(self) -> None:
        cursor = self.cursor
        name = cursor.next().value
        values: list[dict] = []
        if cursor.eat("{"):
            while not cursor.done and not cursor.is_("}"):
                if cursor.is_("@"):
                    cursor.next()
                    cursor.eat("@")
                    attribute = cursor.next()
                    following = cursor.peek(1)
                    if (
                        attribute.value == "map"
                        and cursor.is_("(")
                        and following
                        and following.kind == "string"
                        and values
                    ):
                        values[-1]["value"] = following.value
                    if cursor.is_("("):
                        cursor.skip_group()
                    continue
                if cursor.is_ident():
                    values.append({"name": cursor.next().value})
                else:
                    cursor.next()
            cursor.eat("}")
        self.declarations["enums"].append({"name": name, "values": values})


_SETUP = re.compile(r"^\s*(generator|datasource)\s+\w+\s*\{", re.MULTILINE | re.ASCII)
_MODEL = re.compile(r"^\s*model\s+\w+\s*\{", re.MULTILINE | re.ASCII)
_ATTRIBUTE = re.compile(r"@(id|default|unique|relation)\b")


def _detect(text: str) -> float:
    if _SETUP.search(text):
        return 0.99
    return 0.95 if _MODEL.search(text) and _ATTRIBUTE.search(text) else 0


def _parse(text: str, options: dict | None = None) -> dict:
    if trim(text) == "":
        return failure("empty")
    try:
        tokens = tokenize(text, C_LIKE)
    except LexError as error:
        return failure(error.code, position_at(text, error.index))
    reader = _Reader(text, tokens)
    reader.run()
    if not reader.declarations["models"]:
        return failure("noModels")
    built = build_schema(reader.declarations, PRISMA_TYPES, "prisma", "prisma")
    return {"ok": True, "schema": built["schema"], "warnings": built["warnings"]}


prisma_parser = InputParser("prisma", "schema", "Prisma", (".prisma",), "prisma", _detect, _parse)
