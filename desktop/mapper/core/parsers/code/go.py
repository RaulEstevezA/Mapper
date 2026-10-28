"""Go structs, named types and constants (as enums). Mirrors web/src/core/parsers/code/go.ts."""

import re
import unicodedata

from ...js import coalesce, to_number
from ...model.schema import primitive
from ..types import InputParser
from .lexer import Cursor, LexerConfig, StringRule
from .raw import TypeTable, parse_declarations, raw
from .type_syntax import TypeSyntax, read_type

_LEXER = LexerConfig(
    line_comments=("//",),
    block_comments=(("/*", "*/"),),
    strings=(StringRule("`", "`", False, True), StringRule('"', '"', True, False), StringRule("'", "'", True, False)),
)

_SYNTAX = TypeSyntax(generics="[]", pointers=True, go_collections=True)

GO_TYPES = TypeTable(
    primitives={
        "string": primitive("string"),
        "rune": primitive("integer", 32),
        "int": primitive("integer", 64),
        "int64": primitive("integer", 64),
        "int32": primitive("integer", 32),
        "int16": primitive("integer", 16),
        "int8": primitive("integer", 8),
        "uint": primitive("integer", 64),
        "uint64": primitive("integer", 64),
        "uint32": primitive("integer", 32),
        "uint16": primitive("integer", 16),
        "uint8": primitive("integer", 8),
        "byte": primitive("integer", 8),
        "float64": primitive("float", 64),
        "float32": primitive("float", 32),
        "bool": primitive("boolean"),
        "time.Time": primitive("datetime"),
        "time.Duration": primitive("duration"),
        "uuid.UUID": primitive("uuid"),
        "decimal.Decimal": primitive("decimal"),
        "big.Int": primitive("integer"),
        "big.Float": primitive("decimal"),
        "json.RawMessage": primitive("any"),
        "json.Number": primitive("float"),
        "sql.NullString": primitive("string"),
        "sql.NullInt64": primitive("integer", 64),
        "sql.NullFloat64": primitive("float", 64),
        "sql.NullBool": primitive("boolean"),
        "sql.NullTime": primitive("datetime"),
        "[]byte": primitive("binary"),
        "any": primitive("any"),
        "interface{}": primitive("any"),
    }
)

_TAGS: dict[str, re.Pattern] = {}
_GORM_COLUMN = re.compile(r"column:(\w+)", re.ASCII)
_GENERATED = re.compile(r"autoIncrement|autoCreateTime|autoUpdateTime")
_REQUIRED = re.compile(r"(^|,)required(,|$)")


def tag_value(tag: str, key: str) -> str | None:
    """The value of one key of a struct tag: json:"name,omitempty" db:"user_name" → json gives "name,omitempty"."""
    pattern = _TAGS.get(key)
    if pattern is None:
        pattern = _TAGS[key] = re.compile(rf'(?:^|\s){key}:"([^"]*)"')
    match = pattern.search(tag)
    return match.group(1) if match else None


def _exported(name: str) -> bool:
    return bool(name) and unicodedata.category(name[0]) == "Lu"


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "aliases": {}, "warnings": []}
        self.namespace: str | None = None
        # type Status string: candidates for enums, confirmed when constants of that type exist
        self.named_types: dict[str, dict] = {}

    def _read_go_type(self):
        """Types that need special names: []byte, interface{}, sql.NullString (a nullable value)."""
        cursor = self.cursor
        if cursor.is_("interface") and cursor.is_("{", 1):
            cursor.next()
            cursor.skip_group()
            return raw("interface{}")
        if cursor.is_("struct") and cursor.is_("{", 1):
            # An anonymous struct: its fields are not a named model
            cursor.next()
            cursor.skip_group()
            return raw("any")
        if cursor.is_("func"):
            cursor.next()
            cursor.skip_group()
            token = cursor.peek()
            if not (token and token.line_start) and not cursor.is_("`"):
                read_type(cursor, _SYNTAX)
            return raw("any")
        type_ref = read_type(cursor, _SYNTAX)
        return self._normalize(type_ref) if type_ref else None

    def _normalize(self, type_ref: dict) -> dict:
        args = type_ref["args"]
        if type_ref["name"] == "[]" and args and args[0]["name"] == "byte" and not args[0].get("nullable"):
            result = {"name": "[]byte", "args": []}
            if "nullable" in type_ref:
                result["nullable"] = type_ref["nullable"]
            return result
        if type_ref["name"].startswith("sql.Null"):
            return {**type_ref, "nullable": True}
        return {**type_ref, "args": [self._normalize(arg) for arg in args]}

    def run(self) -> dict:
        cursor = self.cursor
        while not cursor.done:
            if cursor.is_("package") and cursor.is_ident(1):
                cursor.next()
                self.namespace = cursor.next().value
                continue
            if cursor.is_("import"):
                cursor.next()
                if cursor.is_("("):
                    cursor.skip_group()
                else:
                    cursor.next()
                continue
            if cursor.is_("type"):
                doc = cursor.peek().doc
                cursor.next()
                if cursor.is_("("):
                    cursor.next()
                    while not cursor.done and not cursor.is_(")"):
                        if cursor.is_ident():
                            self._type_spec(coalesce(cursor.peek().doc, doc))
                        else:
                            cursor.next()
                    cursor.eat(")")
                elif cursor.is_ident():
                    self._type_spec(doc)
                continue
            if cursor.is_("const"):
                cursor.next()
                self._constants()
                continue
            if cursor.is_("func"):
                # Skip to the body and over it
                cursor.next()
                while not cursor.done and not cursor.is_("{"):
                    if cursor.is_("("):
                        cursor.skip_group()
                    else:
                        cursor.next()
                cursor.skip_group()
                continue
            if cursor.is_("{") or cursor.is_("("):
                cursor.skip_group()
            else:
                cursor.next()
        # Named types with constants became enums; the rest are aliases of their underlying type
        for name, info in self.named_types.items():
            if not any(item["name"] == name for item in self.declarations["enums"]):
                self.declarations["aliases"][name] = info["type"]
        return self.declarations

    def _type_spec(self, doc) -> None:
        cursor = self.cursor
        name = cursor.next().value
        generics: list[str] = []
        # Type parameters: type Page[T any] struct
        if (
            cursor.is_("[")
            and cursor.is_ident(1)
            and not cursor.is_("]", 1)
            and (cursor.is_ident(2) or cursor.is_(",", 2))
        ):
            cursor.next()
            while not cursor.done and not cursor.is_("]"):
                if cursor.is_ident() and cursor.tokens[cursor.index - 1].value in ("[", ","):
                    generics.append(cursor.value())
                cursor.next()
            cursor.eat("]")
        cursor.eat("=")
        if cursor.is_("struct") and cursor.is_("{", 1):
            cursor.next()
            model = {"name": name, "kind": "struct", "fields": [], "generics": generics, "construction": "named"}
            if self.namespace:
                model["namespace"] = self.namespace
            if doc:
                model["description"] = doc
            self.declarations["models"].append(model)
            self._struct_body(model)
            return
        if cursor.is_("interface"):
            cursor.next()
            if cursor.is_("{"):
                cursor.skip_group()
            return
        type_ref = self._read_go_type()
        if type_ref:
            self.named_types[name] = {"type": type_ref, "doc": doc or None}

    def _struct_body(self, model: dict) -> None:
        cursor = self.cursor
        cursor.next()
        while not cursor.done and not cursor.is_("}"):
            if cursor.eat(";"):
                continue
            doc = cursor.peek().doc
            line_start = cursor.index
            names: list[str] = []
            # A, B int declares several fields; a lone type is an embedded struct
            while cursor.is_ident():
                following = cursor.peek(1)
                several = cursor.is_(",", 1)
                typed = (
                    not cursor.is_(".", 1)
                    and not (following and following.line_start)
                    and not cursor.is_("}", 1)
                    and not (following and following.kind == "string")
                )
                if not (several or typed):
                    break
                names.append(cursor.next().value)
                if not cursor.eat(","):
                    break
            current = cursor.peek()
            if (
                not names
                or (current and current.line_start)
                or cursor.is_("}")
                or (current and current.kind == "string")
            ):
                # Embedded struct: its fields are promoted, like inheritance
                cursor.index = line_start
                cursor.eat("*")
                embedded = read_type(cursor, _SYNTAX)
                if embedded:
                    model["extends"] = [*model.get("extends", []), embedded["name"].split(".")[-1]]
                current = cursor.peek()
                if current and current.kind == "string" and not current.line_start:
                    cursor.next()
                continue
            type_start = cursor.index
            type_ref = self._read_go_type()
            type_text = cursor.text_between(self.source, type_start, cursor.index)
            current = cursor.peek()
            tag = cursor.next().value if current and current.kind == "string" and not current.line_start else ""
            for name in names:
                # Unexported fields are never encoded
                if not _exported(name):
                    continue
                field = {"name": name, "type": type_ref, "typeText": type_text}
                if doc:
                    field["description"] = doc
                if tag:
                    field["annotations"] = [{"name": "tag", "args": tag}]
                    json_tag = tag_value(tag, "json")
                    if json_tag == "-":
                        continue
                    if json_tag:
                        wire, *options = json_tag.split(",")
                        if wire:
                            field["serializedName"] = wire
                        if "omitempty" in options or "omitzero" in options:
                            field["optional"] = True
                    gorm = tag_value(tag, "gorm")
                    column = _GORM_COLUMN.search(gorm or "")
                    db = coalesce(tag_value(tag, "db"), column.group(1) if column else None)
                    if db and not field.get("serializedName"):
                        field["serializedName"] = db
                    gorm = gorm or ""
                    if _GENERATED.search(gorm):
                        field["generated"] = True
                    if gorm == "-":
                        continue
                    validation = coalesce(tag_value(tag, "validate"), tag_value(tag, "binding")) or ""
                    if _REQUIRED.search(validation):
                        field["optional"] = False
                model["fields"].append(field)
        cursor.eat("}")

    def _constants(self) -> None:
        """const ( StatusActive Status = "active"; StatusPaid Status = "paid" ), also with iota."""
        cursor = self.cursor
        grouped = cursor.eat("(")
        current_type = None
        iota = 0
        uses_iota = False
        while True:
            if grouped and cursor.is_(")"):
                break
            if not cursor.is_ident():
                cursor.next()
            else:
                name = cursor.next().value
                type_name = cursor.next().value if cursor.is_ident() and not cursor.is_("=") else None
                value = None
                if cursor.eat("="):
                    token = cursor.peek()
                    if token is not None and token.kind == "string":
                        value = token.value
                    elif token is not None and token.kind == "number":
                        value = to_number(token.value)
                    elif token is not None and token.value == "iota":
                        uses_iota = True
                        value = iota
                    while not cursor.done and not cursor.peek().line_start and not cursor.is_(")"):
                        cursor.next()
                    if type_name:
                        current_type = type_name
                    elif value is not None and not uses_iota:
                        current_type = None
                elif uses_iota:
                    value = iota
                iota += 1
                enum_type = type_name if type_name is not None else (current_type if uses_iota else None)
                if enum_type and enum_type in self.named_types:
                    item = next((entry for entry in self.declarations["enums"] if entry["name"] == enum_type), None)
                    if item is None:
                        item = {"name": enum_type, "values": []}
                        doc = self.named_types[enum_type]["doc"]
                        if doc:
                            item["description"] = doc
                        self.declarations["enums"].append(item)
                    # StatusActive → value "active": the constant name is kept as the value's name
                    entry = {"name": name}
                    if value is not None:
                        entry["value"] = value
                    item["values"].append(entry)
            if not (grouped and not cursor.done):
                break
        cursor.eat(")")


_STRUCT = re.compile(r"\btype\s+\w+\s+struct\s*\{", re.ASCII)
_PACKAGE = re.compile(r"^\s*package\s+\w+\s*$", re.MULTILINE | re.ASCII)
_GO_SIGNS = re.compile(r"^\s*(func\s|import\s+(\(|\"))", re.MULTILINE)


def _detect(text: str) -> float:
    if _STRUCT.search(text):
        return 0.95
    # package x alone is also Scala, Java without ;, Kotlin: Go needs one of its own signs too
    if _PACKAGE.search(text):
        return 0.9 if _GO_SIGNS.search(text) else 0.4
    return 0


def _parse(text: str, options: dict | None = None) -> dict:
    return parse_declarations(text, _LEXER, lambda source, tokens: _Reader(source, tokens).run(), GO_TYPES, "go", "go")


go_parser = InputParser("go", "code", "Go", (".go",), "go", _detect, _parse)
