"""Smithy IDL shapes: structures, enums and collections. Mirrors web/src/core/parsers/schema/smithy.ts."""

import re

from ...js import coalesce, to_number, trim
from ...model.schema import primitive
from ..code.annotations import annotation_arg
from ..code.lexer import C_LIKE, Cursor, LexError, tokenize
from ..code.raw import MISSING, TypeTable, build_schema, parse_literal, raw
from ..types import InputParser, failure, position_at

SMITHY_TYPES = TypeTable(
    primitives={
        "String": primitive("string"),
        "Boolean": primitive("boolean"),
        "PrimitiveBoolean": primitive("boolean"),
        "Byte": primitive("integer", 8),
        "Short": primitive("integer", 16),
        "Integer": primitive("integer", 32),
        "PrimitiveInteger": primitive("integer", 32),
        "Long": primitive("integer", 64),
        "PrimitiveLong": primitive("integer", 64),
        "BigInteger": primitive("integer"),
        "Float": primitive("float", 32),
        "Double": primitive("float", 64),
        "PrimitiveDouble": primitive("float", 64),
        "BigDecimal": primitive("decimal"),
        "Timestamp": primitive("datetime"),
        "Blob": primitive("binary"),
        "Document": primitive("any"),
    }
)


def _read_traits(cursor: Cursor, source: str) -> list[dict]:
    """Traits before a shape or member: @required, @jsonName("x"), @documentation("…")."""
    traits = []
    while cursor.is_("@") and cursor.is_ident(1):
        cursor.next()
        name = cursor.next().value
        while (cursor.is_(".") or cursor.is_("#")) and cursor.is_ident(1):
            cursor.next()
            name = cursor.next().value
        trait = {"name": name}
        if cursor.is_("("):
            start = cursor.index
            cursor.skip_group()
            trait["args"] = trim(cursor.text_between(source, start, cursor.index)[1:-1])
        traits.append(trait)
    return traits


def _documentation(traits: list[dict], token) -> str | None:
    trait = next((item for item in traits if item["name"] == "documentation"), None)
    return coalesce(annotation_arg(trait, None) if trait else None, token.doc if token else None)


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "aliases": {}, "warnings": []}
        self.namespace: str | None = None

    def run(self) -> None:
        cursor = self.cursor
        while not cursor.done:
            if cursor.is_("namespace") and cursor.is_ident(1):
                cursor.next()
                name = cursor.next().value
                while cursor.is_(".") and cursor.is_ident(1):
                    cursor.next()
                    name += f".{cursor.next().value}"
                self.namespace = name
                continue
            first = cursor.peek()
            traits = _read_traits(cursor, self.source)
            keyword = cursor.value()
            if keyword in ("structure", "list", "set", "map", "enum", "intEnum", "union") and cursor.is_ident(1):
                cursor.next()
                name = cursor.next().value
                # Mixins and resources: structure A with [B]
                while not cursor.done and not cursor.is_("{"):
                    cursor.next()
                if keyword == "structure":
                    self._structure(name, _documentation(traits, first))
                elif keyword in ("enum", "intEnum"):
                    self._enum(name, _documentation(traits, first))
                else:
                    self._collection(keyword, name)
            elif cursor.is_("{"):
                cursor.skip_group()
            else:
                cursor.next()

    def _members(self) -> list[dict]:
        cursor = self.cursor
        members: list[dict] = []
        if not cursor.eat("{"):
            return members
        while not cursor.done and not cursor.is_("}"):
            if cursor.eat(","):
                continue
            token = cursor.peek()
            traits = _read_traits(cursor, self.source)
            if not cursor.is_ident() or not cursor.is_(":", 1):
                if not cursor.is_("}"):
                    cursor.next()
                continue
            name = cursor.next().value
            cursor.next()
            target = cursor.next().value
            while cursor.is_("#") or cursor.is_("."):
                cursor.next()
                target = cursor.next().value
            member = {"name": name, "target": target, "traits": traits, "token": token}
            if cursor.eat("="):
                start = cursor.index
                if cursor.is_("[") or cursor.is_("{"):
                    cursor.skip_group()
                else:
                    cursor.next()
                member["defaultText"] = cursor.text_between(self.source, start, cursor.index)
            members.append(member)
        cursor.eat("}")
        return members

    def _structure(self, name: str, description: str | None) -> None:
        fields = []
        for member in self._members():
            traits = member["traits"]
            field = {"name": member["name"], "type": raw(member["target"])}
            # Members are optional unless @required (or given a default)
            required = any(trait["name"] == "required" for trait in traits)
            default_trait = next((trait for trait in traits if trait["name"] == "default"), None)
            default = coalesce(member.get("defaultText"), default_trait.get("args") if default_trait else None)
            if default is not None:
                literal = parse_literal(default)
                if literal is not MISSING:
                    field["defaultValue"] = literal
            if not required and default is None:
                field["optional"] = True
            json_name = next((trait for trait in traits if trait["name"] == "jsonName"), None)
            wire = annotation_arg(json_name, None) if json_name else None
            if wire:
                field["serializedName"] = wire
            doc = _documentation(traits, member["token"])
            if doc:
                field["description"] = doc
            if traits:
                field["annotations"] = traits
            fields.append(field)
        model = {"name": name, "kind": "object", "fields": fields, "construction": "named"}
        if self.namespace:
            model["namespace"] = self.namespace
        if description:
            model["description"] = description
        self.declarations["models"].append(model)

    def _collection(self, keyword: str, name: str) -> None:
        """list LineList { member: Line } and map Scores { key: String value: Integer } are aliases."""
        members = self._members()

        def target(member: str) -> dict:
            found = next((item for item in members if item["name"] == member), None)
            return raw(found["target"] if found else "Document")

        aliases = self.declarations["aliases"]
        if keyword in ("list", "set"):
            aliases[name] = raw("[]", [target("member")])
        elif keyword == "map":
            aliases[name] = raw("{}", [target("key"), target("value")])
        else:
            # A union holds one of several shapes: a value of unknown shape for mapping
            aliases[name] = raw("Document")

    def _enum(self, name: str, description: str | None) -> None:
        cursor = self.cursor
        item = {"name": name, "values": []}
        if description:
            item["description"] = description
        if not cursor.eat("{"):
            return
        while not cursor.done and not cursor.is_("}"):
            _read_traits(cursor, self.source)
            if not cursor.is_ident():
                if not cursor.is_("}"):
                    cursor.next()
                continue
            value = {"name": cursor.next().value}
            if cursor.eat("="):
                token = cursor.next()
                if token.kind == "string":
                    value["value"] = token.value
                elif token.kind == "number":
                    value["value"] = to_number(token.value)
            item["values"].append(value)
            cursor.eat(",")
        cursor.eat("}")
        self.declarations["enums"].append(item)


_VERSION = re.compile(r"^\s*\$version\s*:\s*\"[12]", re.MULTILINE)
_STRUCTURE = re.compile(r"^\s*structure\s+\w+\s*\{", re.MULTILINE | re.ASCII)
_NAMESPACE = re.compile(r"^\s*namespace\s+[\w.]+", re.MULTILINE | re.ASCII)


def _detect(text: str) -> float:
    if _VERSION.search(text):
        return 0.99
    return 0.95 if _STRUCTURE.search(text) and _NAMESPACE.search(text) else 0


def _parse(text: str, options: dict | None = None) -> dict:
    if trim(text) == "":
        return failure("empty")
    try:
        # $version and metadata lines start with $: read as punctuation, then skipped
        tokens = tokenize(text, C_LIKE)
    except LexError as error:
        return failure(error.code, position_at(text, error.index))
    reader = _Reader(text, tokens)
    reader.run()
    if not reader.declarations["models"]:
        return failure("noModels")
    built = build_schema(reader.declarations, SMITHY_TYPES, "smithy", "smithy")
    return {"ok": True, "schema": built["schema"], "warnings": built["warnings"]}


smithy_parser = InputParser("smithy", "schema", "Smithy", (".smithy",), "kotlin", _detect, _parse)
