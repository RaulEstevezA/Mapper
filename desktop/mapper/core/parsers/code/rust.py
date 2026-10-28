"""Rust structs and enums, with serde attributes. Mirrors web/src/core/parsers/code/rust.ts."""

import re

from ...js import coalesce, to_number
from ...model.naming import convert_case
from ...model.schema import primitive
from ..types import InputParser
from .annotations import annotation_arg, read_bracket_attributes
from .lexer import Cursor, LexerConfig, StringRule
from .raw import TypeTable, parse_declarations, raw
from .type_syntax import TypeSyntax, read_type

_LEXER = LexerConfig(
    line_comments=("//",),
    block_comments=(("/*", "*/"),),
    nested_comments=True,
    strings=(StringRule('"', '"', True, True),),
    string_prefixes=re.compile(r"^b"),
    raw_hash_strings=True,
)

_SYNTAX = TypeSyntax(generics="<>", references=True, separators=("::",))

RUST_TYPES = TypeTable(
    primitives={
        "String": primitive("string"),
        "str": primitive("string"),
        "char": primitive("string"),
        "i8": primitive("integer", 8),
        "i16": primitive("integer", 16),
        "i32": primitive("integer", 32),
        "i64": primitive("integer", 64),
        "i128": primitive("integer"),
        "isize": primitive("integer", 64),
        "u8": primitive("integer", 8),
        "u16": primitive("integer", 16),
        "u32": primitive("integer", 32),
        "u64": primitive("integer", 64),
        "u128": primitive("integer"),
        "usize": primitive("integer", 64),
        "f32": primitive("float", 32),
        "f64": primitive("float", 64),
        "Decimal": primitive("decimal"),
        "bool": primitive("boolean"),
        "DateTime": primitive("datetime"),
        "NaiveDateTime": primitive("datetime"),
        "OffsetDateTime": primitive("datetime"),
        "PrimitiveDateTime": primitive("datetime"),
        "SystemTime": primitive("datetime"),
        "NaiveDate": primitive("date"),
        "Date": primitive("date"),
        "NaiveTime": primitive("time"),
        "Time": primitive("time"),
        "Duration": primitive("duration"),
        "Uuid": primitive("uuid"),
        "Vec<u8>": primitive("binary"),
        "Bytes": primitive("binary"),
        "Value": primitive("any"),
    },
    lists=("Vec", "VecDeque", "HashSet", "BTreeSet", "IndexSet", "LinkedList"),
    maps=("HashMap", "BTreeMap", "IndexMap"),
    optionals=("Option",),
    transparent=("Box", "Rc", "Arc", "Cow", "RefCell", "Cell"),
)

_SERDE = re.compile(r"\b(Serialize|Deserialize)\b")
_DATABASE = re.compile(r"\b(Queryable|Insertable|FromRow|DeriveEntityModel)\b")
_FLAGS: dict[str, re.Pattern] = {}


def _rename_all(name: str, rule: str) -> str:
    """serde's rename_all conventions."""
    if rule in ("camelCase", "PascalCase", "snake_case", "SCREAMING_SNAKE_CASE"):
        return convert_case(name, rule)
    if rule == "kebab-case":
        return convert_case(name, "snake_case").replace("_", "-")
    if rule == "SCREAMING-KEBAB-CASE":
        return convert_case(name, "SCREAMING_SNAKE_CASE").replace("_", "-")
    if rule == "lowercase":
        return name.lower()
    if rule == "UPPERCASE":
        return name.upper()
    return name


def _serde_flag(attributes: list[dict], flag: str) -> bool:
    pattern = _FLAGS.get(flag)
    if pattern is None:
        pattern = _FLAGS[flag] = re.compile(rf"(^|[\s,]){flag}(\s*[,=]|\s*\Z)")
    return any(item["name"] == "serde" and pattern.search(item.get("args") or "") for item in attributes)


def _serde_value(attributes: list[dict], key: str) -> str | None:
    for item in attributes:
        if item["name"] == "serde":
            value = annotation_arg(item, key)
            if value is not None:
                return value
    return None


def _normalize(type_ref):
    if not type_ref:
        return None
    args = type_ref["args"]
    if type_ref["name"].split("::")[-1] == "Vec" and args and args[0]["name"] == "u8":
        return raw("Vec<u8>")
    return {**type_ref, "args": [item for item in (_normalize(arg) for arg in args) if item]}


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "aliases": {}, "warnings": []}

    def _at_attribute(self) -> bool:
        cursor = self.cursor
        return cursor.is_("#[") or (cursor.is_("#") and cursor.is_("[", 1))

    def _attributes(self) -> list[dict]:
        cursor = self.cursor
        attributes: list[dict] = []
        while self._at_attribute():
            if cursor.is_("#"):
                cursor.next()
            attributes.extend(read_bracket_attributes(cursor, self.source))
        return attributes

    def run(self) -> dict:
        cursor = self.cursor
        attributes: list[dict] = []
        # Documentation written above the attributes belongs to the declaration
        attributes_doc = None
        while not cursor.done:
            if self._at_attribute():
                if not attributes:
                    attributes_doc = cursor.peek().doc
                if cursor.is_("#"):
                    cursor.next()
                attributes.extend(read_bracket_attributes(cursor, self.source))
                continue
            if cursor.is_("#") and cursor.is_("!", 1):
                # Inner attribute: #![allow(...)]
                cursor.next()
                cursor.next()
                cursor.skip_group()
                continue
            doc = coalesce(cursor.peek().doc, attributes_doc if attributes else None)
            if cursor.is_("pub"):
                cursor.next()
                if cursor.is_("("):
                    cursor.skip_group()
            if cursor.is_("struct") and cursor.is_ident(1):
                cursor.next()
                self._struct(attributes, doc)
            elif cursor.is_("enum") and cursor.is_ident(1):
                cursor.next()
                self._enum(attributes, doc)
            elif cursor.is_("type") and cursor.is_ident(1) and cursor.is_("=", 2):
                cursor.next()
                name = cursor.next().value
                cursor.next()
                type_ref = _normalize(read_type(cursor, _SYNTAX))
                if type_ref:
                    self.declarations["aliases"][name] = type_ref
            elif cursor.is_("impl") or cursor.is_("fn") or cursor.is_("mod") or cursor.is_("trait"):
                while not cursor.done and not cursor.is_("{") and not cursor.is_(";"):
                    cursor.next()
                if cursor.is_("{"):
                    cursor.skip_group()
                else:
                    cursor.next()
            elif cursor.is_("{") or cursor.is_("("):
                cursor.skip_group()
            else:
                cursor.next()
            attributes = []
        return self.declarations

    def _generics(self) -> list[str]:
        cursor = self.cursor
        names: list[str] = []
        if not cursor.is_("<"):
            return names
        depth = 0
        while True:
            token = cursor.next()
            if token.value == "<":
                depth += 1
            elif token.value == ">":
                depth -= 1
            elif depth == 1 and token.kind == "ident":
                before = cursor.at(cursor.index - 2)
                if before is not None and before.value in ("<", ","):
                    names.append(token.value)
            if cursor.done or depth <= 0:
                return names

    def _struct(self, attributes: list[dict], doc) -> None:
        cursor = self.cursor
        name = cursor.next().value
        model = {"name": name, "kind": "struct", "fields": [], "generics": self._generics(), "construction": "named"}
        if doc:
            model["description"] = doc
        if attributes:
            model["annotations"] = attributes
        if any(item["name"] == "derive" and _SERDE.search(item.get("args") or "") for item in attributes):
            model["framework"] = "serde"
        if any(item["name"] == "derive" and _DATABASE.search(item.get("args") or "") for item in attributes):
            model["kind"] = "entity"
        # Tuple structs and unit structs have no named fields
        while not cursor.done and not cursor.is_("{") and not cursor.is_("(") and not cursor.is_(";"):
            cursor.next()
        if not cursor.is_("{"):
            if cursor.is_("("):
                cursor.skip_group()
            return
        rule = _serde_value(attributes, "rename_all")
        struct_default = _serde_flag(attributes, "default")
        self.declarations["models"].append(model)
        cursor.next()
        while not cursor.done and not cursor.is_("}"):
            field_doc = cursor.peek().doc
            field_attributes = self._attributes()
            if cursor.eat("pub") and cursor.is_("("):
                cursor.skip_group()
            if not cursor.is_ident():
                cursor.skip_until([","])
                cursor.eat(",")
                continue
            field_name = cursor.next().value
            field_name = field_name[2:] if field_name.startswith("r#") else field_name
            cursor.eat(":")
            type_start = cursor.index
            type_ref = _normalize(read_type(cursor, _SYNTAX))
            field = {
                "name": field_name,
                "type": type_ref,
                "typeText": cursor.text_between(self.source, type_start, cursor.index),
            }
            cursor.skip_until([","])
            cursor.eat(",")
            if field_doc:
                field["description"] = field_doc
            if field_attributes:
                field["annotations"] = field_attributes
            if _serde_flag(field_attributes, "skip") or _serde_flag(field_attributes, "flatten"):
                continue
            rename = coalesce(_serde_value(field_attributes, "rename"), _rename_all(field_name, rule) if rule else None)
            if rename and rename != field_name:
                field["serializedName"] = rename
            alias = _serde_value(field_attributes, "alias")
            if alias:
                field["aliases"] = [alias]
            if struct_default or _serde_flag(field_attributes, "default"):
                field["optional"] = True
            # serde accepts a missing Option field as None
            if type_ref and type_ref["name"].split("::")[-1] == "Option":
                field["optional"] = True
            model["fields"].append(field)
        cursor.eat("}")

    def _enum(self, attributes: list[dict], doc) -> None:
        cursor = self.cursor
        name = cursor.next().value
        self._generics()
        item = {"name": name, "values": []}
        if doc:
            item["description"] = doc
        while not cursor.done and not cursor.is_("{"):
            cursor.next()
        if not cursor.eat("{"):
            return
        rule = _serde_value(attributes, "rename_all")
        following = 0
        while not cursor.done and not cursor.is_("}"):
            variant_attributes = self._attributes()
            if not cursor.is_ident():
                cursor.next()
                continue
            value = {"name": cursor.next().value}
            # Variants with data (Card { last4: String }) keep only their name
            if cursor.is_("(") or cursor.is_("{"):
                cursor.skip_group()
            if cursor.eat("="):
                token = cursor.next()
                if token.kind == "number":
                    value["value"] = to_number(token.value)
                    following = value["value"] + 1 if value["value"] is not None else None
            elif not rule and not _serde_value(variant_attributes, "rename"):
                value["value"] = following
                following = following + 1 if following is not None else None
            rename = coalesce(
                _serde_value(variant_attributes, "rename"), _rename_all(value["name"], rule) if rule else None
            )
            if rename is not None:
                value["value"] = rename
            item["values"].append(value)
            cursor.eat(",")
        cursor.eat("}")
        self.declarations["enums"].append(item)


_DERIVE = re.compile(r"#\[derive\(")
_USE = re.compile(r"^\s*use\s+[\w:]+(::\{[^}]*\})?\s*;", re.MULTILINE | re.ASCII)
_PUB_STRUCT = re.compile(r"\bpub\s+struct\s+\w+", re.ASCII)
_STRUCT = re.compile(r"\bstruct\s+\w+\s*\{[^}]*:\s*(String|Vec<|Option<|i32|i64|u32|u64|f64|bool)", re.ASCII)


def _detect(text: str) -> float:
    if _DERIVE.search(text) or _USE.search(text):
        return 0.95
    if _PUB_STRUCT.search(text) or _STRUCT.search(text):
        return 0.9
    return 0


def _parse(text: str, options: dict | None = None) -> dict:
    return parse_declarations(
        text, _LEXER, lambda source, tokens: _Reader(source, tokens).run(), RUST_TYPES, "rust", "rust"
    )


rust_parser = InputParser("rust", "code", "Rust", (".rs",), "rust", _detect, _parse)
