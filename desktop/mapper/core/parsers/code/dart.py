"""Dart classes (plain, freezed and json_serializable) and enums. Mirrors web/src/core/parsers/code/dart.ts."""

import re

from ...js import coalesce, to_number
from ...model.schema import primitive
from ..types import InputParser
from .annotations import annotation_arg, apply_annotations, read_at_annotation
from .lexer import Cursor, LexerConfig, StringRule
from .raw import MISSING, TypeTable, parse_declarations, parse_literal, raw
from .type_syntax import TypeSyntax, read_type

_LEXER = LexerConfig(
    line_comments=("//",),
    block_comments=(("/*", "*/"),),
    nested_comments=True,
    strings=(
        StringRule('"""', '"""', True, True),
        StringRule("'''", "'''", True, True),
        StringRule('"', '"', True, False),
        StringRule("'", "'", True, False),
    ),
    string_prefixes=re.compile(r"^r"),
    identifier_chars="$",
)

_SYNTAX = TypeSyntax(generics="<>", nullable_suffix=True)

DART_TYPES = TypeTable(
    primitives={
        "String": primitive("string"),
        "int": primitive("integer", 64),
        "BigInt": primitive("integer"),
        "double": primitive("float", 64),
        "num": primitive("float"),
        "Decimal": primitive("decimal"),
        "bool": primitive("boolean"),
        "DateTime": primitive("datetime"),
        "Duration": primitive("duration"),
        "Uint8List": primitive("binary"),
        "dynamic": primitive("any"),
        "Object": primitive("any"),
    },
    lists=("List", "Set", "Iterable", "BuiltList", "BuiltSet"),
    maps=("Map", "BuiltMap"),
)

_MODIFIERS = {"abstract", "sealed", "base", "final", "interface", "mixin", "external", "late", "covariant"}
_DIGITS = re.compile(r"[0-9]+")


def _json_key(annotations: list[dict]) -> list[dict]:
    """@JsonKey(name: 'x'), also includeFromJson: false (not part of the data)."""
    result = []
    for annotation in annotations:
        if annotation["name"] == "JsonKey" and (
            annotation_arg(annotation, "ignore") == "true" or annotation_arg(annotation, "includeFromJson") == "false"
        ):
            result.append({**annotation, "name": "JsonIgnore"})
        else:
            result.append(annotation)
    return result


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "aliases": {}, "warnings": []}

    def _annotations(self) -> list[dict]:
        cursor = self.cursor
        annotations = []
        while cursor.is_("@"):
            annotation = read_at_annotation(cursor, self.source)
            if annotation:
                annotations.append(annotation)
            else:
                cursor.next()
        return annotations

    def run(self) -> dict:
        cursor = self.cursor
        annotations: list[dict] = []
        # Documentation written above the annotations belongs to the declaration
        annotations_doc = None
        while not cursor.done:
            if cursor.is_("@"):
                if not annotations:
                    annotations_doc = cursor.peek().doc
                annotation = read_at_annotation(cursor, self.source)
                if annotation:
                    annotations.append(annotation)
                else:
                    cursor.next()
                continue
            if cursor.value() in ("import", "export", "part", "library") and cursor.peek().line_start:
                cursor.skip_until([";"])
                cursor.eat(";")
                annotations = []
                continue
            if cursor.is_("typedef") and cursor.is_ident(1) and cursor.is_("=", 2):
                cursor.next()
                name = cursor.next().value
                cursor.next()
                type_ref = read_type(cursor, _SYNTAX)
                if type_ref:
                    self.declarations["aliases"][name] = type_ref
                continue
            doc = coalesce(cursor.peek().doc, annotations_doc if annotations else None)
            start = cursor.index
            while cursor.value() in _MODIFIERS and (cursor.is_ident(1) or cursor.is_("class", 1)):
                cursor.next()
            if cursor.is_("class") and cursor.is_ident(1):
                cursor.next()
                self._class(annotations, doc)
                annotations = []
                continue
            if cursor.is_("enum") and cursor.is_ident(1):
                cursor.next()
                self._enum(doc)
                annotations = []
                continue
            if cursor.index == start:
                if cursor.is_("{") or cursor.is_("("):
                    cursor.skip_group()
                else:
                    cursor.next()
            annotations = []
        return self.declarations

    def _class(self, annotations: list[dict], doc) -> None:
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
        model = {"name": name, "kind": "class", "fields": [], "generics": generics, "construction": "named"}
        if doc:
            model["description"] = doc
        if annotations:
            model["annotations"] = annotations
        names = {item["name"] for item in annotations}
        if "freezed" in names or "Freezed" in names:
            model["framework"] = "freezed"
        elif "JsonSerializable" in names:
            model["framework"] = "json_serializable"
        model["extends"] = []
        while not cursor.done and not cursor.is_("{"):
            if cursor.eat("extends"):
                parent = read_type(cursor, _SYNTAX)
                if parent:
                    model["extends"].append(parent["name"])
            else:
                cursor.next()
        self.declarations["models"].append(model)
        self._body(model)

    def _body(self, model: dict) -> None:
        cursor = self.cursor
        if not cursor.eat("{"):
            return
        fields: list[dict] = []
        # Fields set by the constructor: this.name parameters, named ({required this.id}) or positional
        constructor_params: dict[str, dict] = {}
        has_unnamed_constructor = False
        while not cursor.done and not cursor.is_("}"):
            if cursor.eat(";"):
                continue
            doc = cursor.peek().doc
            annotations = self._annotations()
            is_static = is_const = is_factory = False
            while True:
                if cursor.is_("static"):
                    is_static = True
                elif cursor.is_("const"):
                    is_const = True
                elif cursor.is_("factory"):
                    is_factory = True
                elif cursor.value() not in ("late", "final", "external", "covariant", "var"):
                    break
                cursor.next()
            # Constructors: Name(…), Name.named(…), const Name(…), factory Name(…) = _Name
            if cursor.is_(model["name"]) and (cursor.is_("(", 1) or cursor.is_(".", 1)):
                cursor.next()
                is_named_constructor = cursor.eat(".")
                if is_named_constructor:
                    cursor.next()
                this_params, typed, any_named = self._constructor_parameters()
                if not is_named_constructor:
                    has_unnamed_constructor = True
                    constructor_params.update(this_params)
                    # freezed: const factory User({required String name}) = _User; declares the fields
                    if is_factory and cursor.is_("="):
                        fields.extend(typed)
                    if any_named:
                        model["construction"] = "named"
                    elif this_params or typed:
                        model["construction"] = "positional"
                self._skip_member()
                continue
            if cursor.is_("get") or cursor.is_("set") or cursor.is_("operator"):
                self._skip_member()
                continue
            type_start = cursor.index
            type_ref = read_type(cursor, _SYNTAX)
            type_text = cursor.text_between(self.source, type_start, cursor.index)
            if cursor.is_("get") and cursor.is_ident(1):
                self._skip_member()
                continue
            if not type_ref or not cursor.is_ident():
                # final name = 'x'; without a type, or something else
                if type_ref and (cursor.is_("=") or cursor.is_(";")) and not type_ref["args"]:
                    cursor.index = type_start
                    self._untyped_field(fields, is_static or is_const, doc)
                    continue
                self._skip_member()
                continue
            name_token = cursor.next()
            if cursor.is_("(") or cursor.is_("<"):
                self._skip_member()
                continue
            initializer = None
            if cursor.eat("="):
                start = cursor.index
                cursor.skip_until([";", ","])
                initializer = cursor.text_between(self.source, start, cursor.index)
            self._skip_member()
            if is_static or name_token.value.startswith("_"):
                continue
            field = {"name": name_token.value, "type": type_ref, "typeText": type_text}
            if doc:
                field["description"] = doc
            if initializer is not None:
                literal = parse_literal(initializer)
                if literal is not MISSING:
                    field["defaultValue"] = literal
            if apply_annotations(field, _json_key(annotations)):
                fields.append(field)
        cursor.eat("}")
        for field in fields:
            param = constructor_params.get(field["name"])
            if param and param["named"] and not param["required"]:
                field["optional"] = True
                if param.get("default") is not None:
                    literal = parse_literal(param["default"])
                    if literal is not MISSING:
                        field["defaultValue"] = literal
        if not has_unnamed_constructor:
            model["construction"] = "named"
        model["fields"] = fields

    def _untyped_field(self, fields: list[dict], skip: bool, doc) -> None:
        cursor = self.cursor
        name = cursor.next().value
        initializer = ""
        if cursor.eat("="):
            start = cursor.index
            cursor.skip_until([";"])
            initializer = cursor.text_between(self.source, start, cursor.index)
        cursor.eat(";")
        literal = parse_literal(initializer)
        if skip or name.startswith("_") or literal is MISSING or literal is None:
            return
        if isinstance(literal, str):
            type_name = "String"
        elif isinstance(literal, bool):
            type_name = "bool"
        else:
            type_name = "int" if isinstance(literal, int) else "double"
        field = {"name": name, "type": raw(type_name), "defaultValue": literal}
        if doc:
            field["description"] = doc
        fields.append(field)

    def _constructor_parameters(self) -> tuple[dict, list, bool]:
        cursor = self.cursor
        this_params: dict[str, dict] = {}
        typed: list[dict] = []
        any_named = False
        if not cursor.eat("("):
            return this_params, typed, any_named
        named = False
        while not cursor.done and not cursor.is_(")"):
            if cursor.eat("{") or cursor.eat("["):
                named = cursor.tokens[cursor.index - 1].value == "{"
                if named:
                    any_named = True
                continue
            if cursor.eat("}") or cursor.eat("]") or cursor.eat(","):
                continue
            annotations = self._annotations()
            required = cursor.eat("required")
            cursor.eat("final")
            if (cursor.is_("this") or cursor.is_("super")) and cursor.is_(".", 1):
                cursor.next()
                cursor.next()
                name = cursor.next().value
                info = {"named": named, "required": required or not named}
                if cursor.eat("="):
                    start = cursor.index
                    cursor.skip_until([",", "}", "]"])
                    info["default"] = cursor.text_between(self.source, start, cursor.index)
                this_params[name] = info
                continue
            type_start = cursor.index
            type_ref = read_type(cursor, _SYNTAX)
            type_text = cursor.text_between(self.source, type_start, cursor.index)
            if type_ref and cursor.is_ident():
                field = {"name": cursor.next().value, "type": type_ref, "typeText": type_text}
                default_annotation = next((item for item in annotations if item["name"] == "Default"), None)
                if default_annotation and default_annotation.get("args"):
                    literal = parse_literal(default_annotation["args"])
                    if literal is not MISSING:
                        field["defaultValue"] = literal
                    field["optional"] = True
                elif named and not required:
                    field["optional"] = True
                others = [item for item in annotations if item["name"] != "Default"]
                if apply_annotations(field, _json_key(others)):
                    typed.append(field)
            cursor.skip_until([",", "}", "]"])
        cursor.eat(")")
        return this_params, typed, any_named

    def _skip_member(self) -> None:
        """Skips the rest of a member: an initializer list, a body or ;."""
        cursor = self.cursor
        while not cursor.done and not cursor.is_(";") and not cursor.is_("}"):
            if cursor.is_("(") or cursor.is_("["):
                cursor.skip_group()
                continue
            if cursor.is_("{"):
                cursor.skip_group()
                return
            if cursor.is_("=>"):
                cursor.skip_until([";"])
                break
            cursor.next()
        cursor.eat(";")

    def _enum(self, doc) -> None:
        cursor = self.cursor
        item = {"name": cursor.next().value, "values": []}
        if doc:
            item["description"] = doc
        while not cursor.done and not cursor.is_("{"):
            cursor.next()
        if not cursor.eat("{"):
            return
        while not cursor.done and not cursor.is_("}") and not cursor.is_(";"):
            wire = None
            while cursor.is_("@"):
                annotation = read_at_annotation(cursor, self.source)
                if annotation and annotation["name"] == "JsonValue":
                    wire = coalesce(annotation_arg(annotation, None), annotation.get("args"))
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
            if wire is not None:
                value["value"] = to_number(wire) if _DIGITS.fullmatch(wire) else wire
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


_PACKAGE_IMPORT = re.compile(r"^import\s+['\"]package:", re.MULTILINE)
_CODEGEN = re.compile(r"@(freezed|JsonSerializable)\b")
_FINAL_FIELD = re.compile(r"\bfinal\s+[\w<>?, ]+\s+\w+\s*;", re.ASCII)
_CLASS = re.compile(r"\bclass\s+\w+", re.ASCII)
_THIS_PARAM = re.compile(r"\b(required\s+)?this\.\w+", re.ASCII)
_COMMON_FINAL = re.compile(r"\bfinal\s+(String|int|double|bool|DateTime|List<)")


def _detect(text: str) -> float:
    if _PACKAGE_IMPORT.search(text) or _CODEGEN.search(text):
        return 0.95
    if _FINAL_FIELD.search(text) and _CLASS.search(text) and _THIS_PARAM.search(text):
        return 0.9
    if _CLASS.search(text) and _COMMON_FINAL.search(text):
        return 0.75
    return 0


def _parse(text: str, options: dict | None = None) -> dict:
    return parse_declarations(
        text, _LEXER, lambda source, tokens: _Reader(source, tokens).run(), DART_TYPES, "dart", "dart"
    )


dart_parser = InputParser("dart", "code", "Dart", (".dart",), "dart", _detect, _parse)
