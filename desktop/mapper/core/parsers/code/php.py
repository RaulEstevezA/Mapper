"""PHP classes (with constructor promotion, Doctrine attributes and docblock types) and enums. Mirrors
web/src/core/parsers/code/php.ts."""

import re

from ...js import to_number, trim
from ...model.schema import primitive
from ..types import InputParser, failure, position_at
from .annotations import apply_annotations, read_bracket_attributes
from .lexer import C_LIKE, Cursor, LexerConfig, LexError, tokenize
from .raw import MISSING, TypeTable, build_schema, parse_literal
from .type_syntax import TypeSyntax, read_type

_LEXER = LexerConfig(
    line_comments=("//", "#"),
    block_comments=(("/*", "*/"),),
    strings=C_LIKE.strings,
    identifier_chars="$",
    hash_attributes=True,
)

_SYNTAX = TypeSyntax(generics="<>", nullable_prefix=True, unions=True, array_suffix=True, separators=("\\",))

PHP_TYPES = TypeTable(
    primitives={
        "string": primitive("string"),
        "int": primitive("integer", 64),
        "integer": primitive("integer", 64),
        "float": primitive("float", 64),
        "double": primitive("float", 64),
        "bool": primitive("boolean"),
        "boolean": primitive("boolean"),
        "true": primitive("boolean"),
        "false": primitive("boolean"),
        "DateTime": primitive("datetime"),
        "DateTimeImmutable": primitive("datetime"),
        "DateTimeInterface": primitive("datetime"),
        "Carbon": primitive("datetime"),
        "CarbonImmutable": primitive("datetime"),
        "DateInterval": primitive("duration"),
        "UuidInterface": primitive("uuid"),
        "Uuid": primitive("uuid"),
        "mixed": primitive("any"),
        "object": primitive("any"),
        "stdClass": primitive("any"),
    },
    # array alone is a list of unknown items; docblocks usually say more (@var Item[])
    lists=("array", "iterable", "Collection", "ArrayCollection", "list", "non-empty-array", "non-empty-list"),
    null_names=("null",),
    case_insensitive=True,
)

_MODIFIERS = {"public", "private", "protected", "static", "readonly", "final", "abstract", "var"}
_VISIBILITY = {"public", "private", "protected", "readonly"}
_LIST_NAMES = ("array", "collection", "arraycollection", "iterable")
_VAR = re.compile(r"@var\s+([^\s*]+)")
_ENTITY = re.compile(r"(^|\\)Entity\Z")
_GETTER = re.compile(r"^(get|is|has)[A-Z]")
_SPACES = re.compile(r"\s+")
_OPEN_TAG = re.compile(r"^\s*<\?php")


def _simple(type_ref: dict) -> str:
    return type_ref["name"].split("\\")[-1].lower()


def _with_nullable(type_ref: dict, nullable) -> dict:
    result = {key: value for key, value in type_ref.items() if key != "nullable"}
    if nullable is not None:
        result["nullable"] = nullable
    return result


def _doc_type(doc_raw: str | None, pattern: re.Pattern):
    """Type of a docblock tag (@var Collection<int, Order>, @param list<Item> $items)."""
    match = pattern.search(doc_raw) if doc_raw else None
    if not match:
        return None
    try:
        type_ref = read_type(Cursor(tokenize(match.group(1), _LEXER)), _SYNTAX)
    except LexError:
        return None
    if not type_ref:
        return None
    # array<int, Item> and Collection<int, Item>: the last argument is the item
    if len(type_ref["args"]) == 2 and _simple(type_ref) in _LIST_NAMES:
        return _with_nullable({"name": "[]", "args": [type_ref["args"][1]]}, type_ref.get("nullable"))
    return type_ref


def _refine(declared, documented):
    """A docblock type is more precise when the declared type is just array or missing."""
    if not documented:
        return declared
    if not declared:
        return documented

    def plain_list(type_ref: dict) -> bool:
        return _simple(type_ref) in _LIST_NAMES and not type_ref["args"]

    if plain_list(declared):
        return _with_nullable(documented, declared.get("nullable") or documented.get("nullable"))
    if declared["name"] == "|":
        return {**declared, "args": [documented if plain_list(arg) else arg for arg in declared["args"]]}
    return declared


def _doctrine(field: dict, attributes: list[dict]) -> bool:
    """Doctrine mapping attributes: column names, nullability and generated ids."""
    normalized = [{**item, "name": item["name"].split("\\")[-1]} for item in attributes]
    if not apply_annotations(field, normalized):
        return False
    if any(item["name"] == "GeneratedValue" for item in normalized):
        field["generated"] = True
    return True


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "warnings": []}
        self.namespace: str | None = None

    def _attributes(self) -> list[dict]:
        attributes: list[dict] = []
        while self.cursor.is_("#["):
            attributes.extend(read_bracket_attributes(self.cursor, self.source))
        return attributes

    def run(self) -> dict:
        cursor = self.cursor
        attributes: list[dict] = []
        while not cursor.done:
            if cursor.is_("#["):
                attributes.extend(read_bracket_attributes(cursor, self.source))
                continue
            if cursor.is_("namespace"):
                cursor.next()
                start = cursor.index
                while not cursor.done and not cursor.is_(";") and not cursor.is_("{"):
                    cursor.next()
                self.namespace = _SPACES.sub("", cursor.text_between(self.source, start, cursor.index))
                cursor.next()
                continue
            if cursor.is_("use") and cursor.peek().line_start:
                cursor.skip_until([";"])
                cursor.eat(";")
                continue
            doc = cursor.peek().doc
            while cursor.value() in ("final", "abstract", "readonly") and cursor.is_ident(1):
                cursor.next()
            if cursor.is_("class") and cursor.is_ident(1):
                cursor.next()
                self._class(attributes, doc)
            elif cursor.is_("enum") and cursor.is_ident(1):
                cursor.next()
                self._enum(doc)
            elif (cursor.is_("interface") or cursor.is_("trait")) and cursor.is_ident(1):
                while not cursor.done and not cursor.is_("{"):
                    cursor.next()
                cursor.skip_group()
            elif cursor.is_("{") or cursor.is_("("):
                cursor.skip_group()
            else:
                cursor.next()
            attributes = []
        return self.declarations

    def _class(self, attributes: list[dict], doc) -> None:
        cursor = self.cursor
        model = {"name": cursor.next().value, "kind": "class", "fields": [], "construction": "properties"}
        if self.namespace:
            model["namespace"] = self.namespace
        if doc:
            model["description"] = doc
        if attributes:
            model["annotations"] = attributes
        if any(_ENTITY.search(item["name"]) for item in attributes):
            model["kind"] = "entity"
            model["framework"] = "doctrine"
        model["extends"] = []
        while not cursor.done and not cursor.is_("{"):
            if cursor.eat("extends"):
                parent = read_type(cursor, _SYNTAX)
                if parent:
                    model["extends"].append(parent["name"].split("\\")[-1])
            else:
                cursor.next()
        self.declarations["models"].append(model)
        getters = 0
        cursor.next()
        while not cursor.done and not cursor.is_("}"):
            if cursor.eat(";"):
                continue
            token = cursor.peek()
            doc_raw = token.doc_raw
            member_doc = token.doc
            member_attributes = self._attributes()
            modifiers: set[str] = set()
            while cursor.value() in _MODIFIERS:
                modifiers.add(cursor.next().value)
            if cursor.is_("use") or cursor.is_("const"):
                cursor.skip_until([";"])
                cursor.eat(";")
                continue
            if cursor.is_("function"):
                cursor.next()
                function_name = cursor.next().value
                if function_name == "__construct":
                    promoted = self._constructor_parameters(doc_raw)
                    model["fields"].extend(promoted)
                    if promoted:
                        model["construction"] = "named"
                else:
                    if _GETTER.match(function_name):
                        getters += 1
                    if cursor.is_("("):
                        cursor.skip_group()
                while not cursor.done and not cursor.is_("{") and not cursor.is_(";"):
                    cursor.next()
                if cursor.is_("{"):
                    cursor.skip_group()
                else:
                    cursor.eat(";")
                continue
            # Property: [type] $name [= default];
            type_ref = None
            type_start = cursor.index
            if not cursor.value().startswith("$"):
                type_ref = read_type(cursor, _SYNTAX)
            type_text = cursor.text_between(self.source, type_start, cursor.index)
            if not cursor.value().startswith("$"):
                cursor.skip_until([";"])
                cursor.eat(";")
                continue
            name_token = cursor.next()
            default_text = None
            if cursor.eat("="):
                start = cursor.index
                cursor.skip_until([";", ","])
                default_text = cursor.text_between(self.source, start, cursor.index)
            cursor.skip_until([";"])
            cursor.eat(";")
            if "static" in modifiers:
                continue
            field = {"name": name_token.value[1:], "type": _refine(type_ref, _doc_type(doc_raw, _VAR))}
            if type_text:
                field["typeText"] = type_text
            if member_doc:
                field["description"] = member_doc
            if default_text is not None:
                literal = parse_literal(default_text)
                if literal is not MISSING:
                    field["defaultValue"] = literal
                field["optional"] = True
            if not _doctrine(field, member_attributes):
                continue
            model["fields"].append(field)
        cursor.eat("}")
        model["metadata"] = {"accessors": "getters" if getters > 0 else "properties"}

    def _constructor_parameters(self, doc_raw) -> list[dict]:
        cursor = self.cursor
        fields: list[dict] = []
        if not cursor.eat("("):
            return fields
        while not cursor.done and not cursor.is_(")"):
            attributes = self._attributes()
            promoted = False
            while cursor.value() in _VISIBILITY:
                cursor.next()
                promoted = True
            type_ref = None
            type_start = cursor.index
            if not cursor.value().startswith("$") and not cursor.is_("&") and not cursor.is_("..."):
                type_ref = read_type(cursor, _SYNTAX)
            type_text = cursor.text_between(self.source, type_start, cursor.index)
            cursor.eat("&")
            cursor.eat("...")
            if not cursor.value().startswith("$"):
                cursor.skip_until([","])
                cursor.eat(",")
                continue
            name = cursor.next().value[1:]
            default_text = None
            if cursor.eat("="):
                start = cursor.index
                cursor.skip_until([","])
                default_text = cursor.text_between(self.source, start, cursor.index)
            cursor.eat(",")
            if not promoted:
                continue
            param = re.compile(rf"@param\s+([^\s*]+)\s+\${name}\b")
            field = {"name": name, "type": _refine(type_ref, _doc_type(doc_raw, param))}
            if type_text:
                field["typeText"] = type_text
            if default_text is not None:
                literal = parse_literal(default_text)
                if literal is not MISSING:
                    field["defaultValue"] = literal
                field["optional"] = True
            if _doctrine(field, attributes):
                fields.append(field)
        cursor.eat(")")
        return fields

    def _enum(self, doc) -> None:
        cursor = self.cursor
        item = {"name": cursor.next().value, "values": []}
        if self.namespace:
            item["namespace"] = self.namespace
        if doc:
            item["description"] = doc
        while not cursor.done and not cursor.is_("{"):
            cursor.next()
        if not cursor.eat("{"):
            return
        while not cursor.done and not cursor.is_("}"):
            if cursor.eat("case") and cursor.is_ident():
                value = {"name": cursor.next().value}
                if cursor.eat("="):
                    token = cursor.next()
                    if token.kind == "string":
                        value["value"] = token.value
                    elif token.kind == "number":
                        value["value"] = to_number(token.value)
                item["values"].append(value)
                cursor.skip_until([";"])
                cursor.eat(";")
            elif cursor.is_("{") or cursor.is_("("):
                cursor.skip_group()
            else:
                cursor.next()
        cursor.eat("}")
        self.declarations["enums"].append(item)


_PROPERTY = re.compile(r"\b(public|private|protected)\s+(\??[\w\\|]+\s+)?\$\w+")


def _detect(text: str) -> float:
    if _OPEN_TAG.match(text):
        return 0.99
    if _PROPERTY.search(text):
        return 0.9
    return 0


def _parse(text: str, options: dict | None = None) -> dict:
    if trim(text) == "":
        return failure("empty")
    try:
        # The opening tag is blanked out, keeping every position in place
        tokens = tokenize(_OPEN_TAG.sub(lambda match: " " * len(match.group(0)), text, count=1), _LEXER)
    except LexError as error:
        return failure(error.code, position_at(text, error.index))
    declarations = _Reader(text, tokens).run()
    if not declarations["models"] and not declarations["enums"]:
        return failure("noModels")
    built = build_schema(declarations, PHP_TYPES, "php", "php")
    return {"ok": True, "schema": built["schema"], "warnings": built["warnings"]}


php_parser = InputParser("php", "code", "PHP", (".php",), "php", _detect, _parse)
