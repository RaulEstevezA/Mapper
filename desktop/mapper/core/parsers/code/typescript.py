"""TypeScript interfaces, type aliases, classes and enums, and JavaScript classes with JSDoc; Zod schemas in
either. Mirrors web/src/core/parsers/code/typescript.ts."""

import json
import re

from ...js import number_text, to_number, trim
from ...model.naming import to_pascal_case, unique_name
from ...model.schema import primitive
from ..types import InputParser, failure, position_at
from .annotations import apply_annotations, read_at_annotation
from .lexer import C_LIKE, Cursor, LexerConfig, LexError, StringRule, tokenize
from .raw import MISSING, TypeTable, build_schema, parse_literal, raw
from .type_syntax import TypeSyntax, read_type
from .zod import ZodReader

_LEXER = LexerConfig(
    line_comments=C_LIKE.line_comments,
    block_comments=C_LIKE.block_comments,
    strings=(StringRule("`", "`", True, True), *C_LIKE.strings),
    identifier_chars="$",
)

TYPESCRIPT_TYPES = TypeTable(
    primitives={
        "string": primitive("string"),
        "String": primitive("string"),
        "number": primitive("float"),
        "Number": primitive("float"),
        # Zod's .int(): TypeScript has no integer type of its own
        "integer": primitive("integer"),
        "bigint": primitive("integer", 64),
        "boolean": primitive("boolean"),
        "Boolean": primitive("boolean"),
        "Date": primitive("datetime"),
        "any": primitive("any"),
        "unknown": primitive("any"),
        "object": primitive("any"),
        "Object": primitive("any"),
        "Buffer": primitive("binary"),
        "Uint8Array": primitive("binary"),
        "ArrayBuffer": primitive("binary"),
        "Blob": primitive("binary"),
    },
    lists=("Array", "ReadonlyArray", "Set", "ReadonlySet"),
    maps=("Record", "Map", "ReadonlyMap"),
    transparent=("Readonly", "Partial", "Required", "NonNullable", "Promise"),
    null_names=("null", "undefined", "void"),
)

_MEMBER_MODIFIERS = {
    "readonly",
    "public",
    "private",
    "protected",
    "declare",
    "abstract",
    "override",
    "accessor",
    "static",
}
_PARAMETER_PROPERTY = {"public", "private", "protected", "readonly"}
_NUMBER_START = re.compile(r"^-?[0-9]")
_HERITAGE_SYNTAX = TypeSyntax(generics="<>")
_JSDOC_SYNTAX = TypeSyntax(generics="<>", array_suffix=True, unions=True, nullable_prefix=True)


def _is_literal_name(name: str) -> bool:
    return name.startswith('"') or bool(_NUMBER_START.match(name))


def _literal_text(name: str) -> str:
    """String(literalValue(name)): the text of a string literal, or the number as JavaScript writes it."""
    if name.startswith('"'):
        return json.loads(name)
    value = to_number(name)
    return "NaN" if value is None else number_text(value)


def _type_of_initializer(text: str):
    """Type of an initial value: '' is a string, 0 a number, [] an array, new Date() a date."""
    value = trim(text)
    if value[:1] in ('"', "'", "`") and value:
        return raw("string")
    if _NUMBER_START.match(value):
        return raw("number")
    if value in ("true", "false"):
        return raw("boolean")
    if re.match(r"new\s+Date\b", value):
        return raw("Date")
    if value.startswith("["):
        return raw("[]", [raw("any")])
    if re.match(r"new\s+(Map|Set)\b", value):
        return raw("Map" if re.match(r"new\s+Map", value) else "Set")
    if value in ("null", "undefined"):
        return {"name": "any", "args": [], "nullable": True}
    return None


def _parse_jsdoc_type(text: str):
    cleaned = re.sub(r"^\(|\)$", "", text).replace("Object.<", "Object<").replace("*", "any")
    try:
        tokens = tokenize(cleaned, _LEXER)
    except LexError:
        return None
    type_ref = read_type(Cursor(tokens), _JSDOC_SYNTAX)
    if type_ref and type_ref["name"] == "Object" and len(type_ref["args"]) == 2:
        return raw("Record", type_ref["args"])
    return type_ref


def _jsdoc_type(doc_raw: str):
    match = re.search(r"@type\s*\{([^}]*)\}", doc_raw)
    return _parse_jsdoc_type(match.group(1)) if match else None


def _jsdoc_param(doc_raw: str, name: str):
    match = re.search(rf"@param\s*\{{([^}}]*)\}}\s*\[?{re.escape(name)}\b", doc_raw)
    return _parse_jsdoc_type(match.group(1)) if match else None


_TYPEDEF_BLOCK = re.compile(r"/\*\*[\s\S]*?\*/")
_TYPEDEF = re.compile(r"@typedef\s*(?:\{([^}]*)\})?\s*([\w$]+)", re.ASCII)
_PROPERTY = re.compile(
    r"@prop(?:erty)?\s*\{([^}]*)\}\s*(\[?)([\w$.]+)(?:=([^\]\s]*))?\]?[ \t]*(?:-[ \t]*)?(.*)", re.ASCII
)
_COMMENT_END = re.compile(r"\*/\s*$")


class _Reader:
    """Shared by TypeScript and JavaScript: JavaScript has no type annotations, so its fields get their types
    from JSDoc or from their initial value."""

    def __init__(self, source: str, tokens: list, javascript: bool):
        self.source = source
        self.cursor = Cursor(tokens)
        self.javascript = javascript
        self.declarations = {"models": [], "enums": [], "aliases": {}, "warnings": []}
        self.used_names: set[str] = set()
        # Models created for inline object types, merged into their alias when it is an intersection
        self.inline_models: set[str] = set()
        # Name for the next inline object type (address: { city: string } → UserAddress)
        self.inline_hint = "Inline"
        self.syntax = TypeSyntax(
            generics="<>",
            array_suffix=True,
            unions=True,
            intersections=True,
            nullable_prefix=javascript,
            custom=lambda cursor: self._inline_object() if cursor.is_("{") else None,
        )

    def _reserve(self, name: str) -> str:
        self.used_names.add(name)
        return name

    def run(self) -> dict:
        cursor = self.cursor
        tokens = cursor.tokens
        # Declared names first, so inline models never take a name used later in the file
        for index in range(len(tokens) - 1):
            if tokens[index].value in ("interface", "class", "enum", "type") and tokens[index + 1].kind == "ident":
                self.used_names.add(tokens[index + 1].value)
        decorators: list[dict] = []
        while not cursor.done:
            if cursor.is_("@"):
                first = cursor.peek()
                decorator = read_at_annotation(cursor, self.source)
                if decorator:
                    decorators.append(decorator)
                else:
                    cursor.next()
                self._pass_doc(first)
                continue
            if cursor.value() in ("export", "declare", "default", "abstract") and cursor.peek().kind == "ident":
                self._pass_doc(cursor.next())
                continue
            if cursor.is_("interface") and cursor.is_ident(1) and not self.javascript:
                self._interface()
            elif (
                cursor.is_("type")
                and cursor.is_ident(1)
                and (cursor.is_("=", 2) or cursor.is_("<", 2))
                and not self.javascript
            ):
                self._type_alias()
            elif cursor.is_("class") and cursor.is_ident(1):
                self._class(decorators)
            elif (cursor.is_("enum") and cursor.is_ident(1)) or (cursor.is_("const") and cursor.is_("enum", 1)):
                self._enum()
            elif (cursor.is_("namespace") or cursor.is_("module")) and cursor.is_ident(1):
                # Declarations inside a namespace are read like top-level ones
                cursor.next()
                while not cursor.done and not cursor.is_("{"):
                    cursor.next()
                cursor.next()
            elif cursor.is_("(") or cursor.is_("[") or cursor.is_("{"):
                cursor.skip_group()
            else:
                cursor.next()
            if not cursor.is_("@"):
                decorators = []
        if self.javascript:
            self._typedefs()
        return self.declarations

    def _pass_doc(self, origin) -> None:
        """The documentation written before export or a decorator belongs to the declaration that follows."""
        following = self.cursor.peek()
        if following and origin.doc is not None and following.doc is None:
            self.cursor.tokens[self.cursor.index] = following.copy(doc=origin.doc, doc_raw=origin.doc_raw)

    def _type_parameters(self) -> list[str]:
        cursor = self.cursor
        if not cursor.is_("<"):
            return []
        names: list[str] = []
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

    def _heritage(self) -> list[str]:
        cursor = self.cursor
        parents: list[str] = []
        while not cursor.done and not cursor.is_("{"):
            if cursor.eat("extends"):
                while True:
                    type_ref = read_type(cursor, _HERITAGE_SYNTAX)
                    if type_ref:
                        parents.append(type_ref["name"])
                    if not cursor.eat(","):
                        break
            elif cursor.is_("implements"):
                # Implemented interfaces declare no data of their own
                cursor.next()
                while True:
                    read_type(cursor, _HERITAGE_SYNTAX)
                    if not cursor.eat(","):
                        break
            else:
                cursor.next()
        return parents

    def _interface(self) -> None:
        cursor = self.cursor
        doc = cursor.peek().doc
        cursor.next()
        name = self._reserve(cursor.next().value)
        model = {
            "name": name,
            "kind": "interface",
            "fields": [],
            "generics": self._type_parameters(),
            "extends": self._heritage(),
        }
        if doc:
            model["description"] = doc
        self.declarations["models"].append(model)
        model["fields"] = self._members(name)

    def _type_alias(self) -> None:
        cursor = self.cursor
        doc = cursor.peek().doc
        cursor.next()
        name = self._reserve(cursor.next().value)
        generics = self._type_parameters()
        cursor.eat("=")
        if cursor.is_("{"):
            model = {"name": name, "kind": "type", "fields": [], "generics": generics}
            if doc:
                model["description"] = doc
            self.declarations["models"].append(model)
            model["fields"] = self._members(name)
            return
        self.inline_hint = name
        type_ref = read_type(cursor, self.syntax)
        if not type_ref:
            return
        options = type_ref["args"] if type_ref["name"] == "|" else [type_ref]
        literals = [option for option in options if _is_literal_name(option["name"])]
        real = [option for option in options if option["name"] not in ("null", "undefined")]
        if literals and len(literals) == len(real):
            item = {
                "name": name,
                "kind": "literals",
                "values": [{"name": _literal_text(option["name"])} for option in literals],
            }
            if doc:
                item["description"] = doc
            self.declarations["enums"].append(item)
            return
        if type_ref["name"] == "&":
            # type Admin = User & { role: string }: the inline parts become fields of Admin itself
            model = {"name": name, "kind": "type", "fields": [], "generics": generics, "extends": []}
            for part in type_ref["args"]:
                inline = next(
                    (
                        item
                        for item in self.declarations["models"]
                        if item["name"] == part["name"] and item["name"] in self.inline_models
                    ),
                    None,
                )
                if inline is not None:
                    model["fields"].extend(inline["fields"])
                    self.declarations["models"].remove(inline)
                else:
                    model["extends"].append(part["name"])
            self.declarations["models"].append(model)
            return
        self.declarations["aliases"][name] = type_ref

    def _inline_object(self):
        name = unique_name(to_pascal_case(self.inline_hint) or "Inline", self.used_names)
        model = {"name": name, "kind": "type", "fields": []}
        self.inline_models.add(name)
        self.declarations["models"].append(model)
        model["fields"] = self._members(name)
        return raw(name)

    def _members(self, owner: str, is_class: bool = False) -> list[dict]:
        """Members between braces: properties of an interface, type literal or class."""
        cursor = self.cursor
        fields: list[dict] = []
        if not cursor.eat("{"):
            return fields
        decorators: list[dict] = []
        while not cursor.done and not cursor.is_("}"):
            if cursor.eat(";") or cursor.eat(","):
                continue
            if cursor.is_("@"):
                decorator = read_at_annotation(cursor, self.source)
                if decorator:
                    decorators.append(decorator)
                else:
                    cursor.next()
                continue
            token = cursor.peek()
            doc, doc_raw = token.doc, token.doc_raw
            is_static = False
            while cursor.value() in _MEMBER_MODIFIERS and (
                cursor.is_ident(1)
                or (cursor.peek(1) is not None and cursor.peek(1).kind == "string")
                or cursor.is_("[", 1)
                or cursor.is_("#", 1)
            ):
                if cursor.next().value == "static":
                    is_static = True
            if cursor.is_("[") or cursor.is_("(") or cursor.is_("<"):
                # Index or call signatures: [key: string]: T, (x: number): string
                cursor.skip_until([";", ","])
                decorators = []
                continue
            following = cursor.peek(1)
            if (
                (cursor.is_("get") or cursor.is_("set"))
                and (cursor.is_ident(1) or (following is not None and following.kind == "string"))
                and cursor.is_("(", 2)
            ):
                self._skip_method()
                decorators = []
                continue
            if is_class and cursor.is_("constructor") and cursor.is_("(", 1):
                cursor.next()
                fields.extend(self._constructor_properties(doc_raw))
                decorators = []
                continue
            private_name = cursor.eat("#")
            name_token = cursor.peek()
            if not name_token or name_token.kind not in ("ident", "string", "number"):
                cursor.next()
                continue
            cursor.next()
            if cursor.is_("(") or (cursor.is_("<") and not self.javascript):
                cursor.index -= 1
                self._skip_method()
                decorators = []
                continue
            # name?: T is read as ?: by the lexer; name!: T is a definite assignment
            optional = self._optional_marker()
            if not optional:
                cursor.eat("!")
            type_ref = None
            type_start = -1
            if cursor.eat(":"):
                self.inline_hint = f"{owner}{to_pascal_case(name_token.value)}"
                type_start = cursor.index
                type_ref = read_type(cursor, self.syntax)
            type_end = cursor.index
            initializer = self._read_initializer() if cursor.eat("=") else None
            if is_static or private_name:
                decorators = []
                continue
            if not type_ref and initializer is not None:
                type_ref = _type_of_initializer(initializer)
            if self.javascript and doc_raw:
                type_ref = _jsdoc_type(doc_raw) or type_ref
            field = {
                "name": name_token.value,
                "type": self._literal_union_to_enum(type_ref, owner, name_token.value),
                "optional": optional,
            }
            if type_start >= 0 and type_end > type_start:
                field["typeText"] = cursor.text_between(self.source, type_start, type_end)
            if doc:
                field["description"] = doc
            if initializer is not None:
                literal = parse_literal(initializer)
                if literal is not MISSING:
                    field["defaultValue"] = literal
            if apply_annotations(field, decorators):
                fields.append(field)
            decorators = []
        cursor.eat("}")
        return fields

    def _literal_union_to_enum(self, type_ref, owner: str, field_name: str):
        """status: 'active' | 'blocked' creates an enum, so mapping its values can be checked."""
        if not type_ref or type_ref["name"] != "|":
            return type_ref
        literals = [option for option in type_ref["args"] if _is_literal_name(option["name"])]
        others = [option for option in type_ref["args"] if not _is_literal_name(option["name"])]
        if len(literals) < 2 or any(option["name"] not in ("null", "undefined") for option in others):
            return type_ref
        name = unique_name(to_pascal_case(field_name) or f"{owner}Value", self.used_names)
        self.declarations["enums"].append(
            {
                "name": name,
                "kind": "literals",
                "values": [{"name": _literal_text(option["name"])} for option in literals],
            }
        )
        enum_type = raw(name)
        return raw("|", [enum_type, *others]) if others else enum_type

    def _optional_marker(self) -> bool:
        """? after a name, also when the lexer read it together with the colon (?:), which is left as :."""
        cursor = self.cursor
        if cursor.is_("?:"):
            cursor.tokens[cursor.index] = cursor.tokens[cursor.index].copy(value=":")
            return True
        return cursor.eat("?")

    def _read_initializer(self) -> str:
        cursor = self.cursor
        start = cursor.index
        depth = 0
        while not cursor.done:
            token = cursor.peek()
            if (
                cursor.index > start
                and depth == 0
                and (token.line_start or cursor.is_(";") or cursor.is_(",") or cursor.is_("}"))
            ):
                break
            if token.kind == "punct" and token.value in ("(", "[", "{"):
                depth += 1
            if token.kind == "punct" and token.value in (")", "]", "}"):
                depth -= 1
            cursor.next()
        return cursor.text_between(self.source, start, cursor.index)

    def _skip_method(self) -> None:
        cursor = self.cursor
        while not cursor.done and not cursor.is_("("):
            cursor.next()
        cursor.skip_group()
        if cursor.eat(":"):
            read_type(cursor, self.syntax)
        if cursor.is_("{"):
            cursor.skip_group()

    def _constructor_properties(self, doc_raw) -> list[dict]:
        """constructor(public id: number, private readonly name?: string) declares properties (TypeScript); in
        JavaScript, this.x = … assignments in the body do."""
        cursor = self.cursor
        fields: list[dict] = []
        param_types: dict = {}
        cursor.next()
        while not cursor.done and not cursor.is_(")"):
            decorators: list[dict] = []
            while cursor.is_("@"):
                decorator = read_at_annotation(cursor, self.source)
                if not decorator:
                    break
                decorators.append(decorator)
            is_property = False
            while cursor.value() in _PARAMETER_PROPERTY and cursor.is_ident(1):
                cursor.next()
                is_property = True
            if not cursor.is_ident():
                cursor.skip_until([","])
                cursor.eat(",")
                continue
            name = cursor.next().value
            optional = self._optional_marker()
            type_ref = None
            if cursor.eat(":"):
                self.inline_hint = name
                type_ref = read_type(cursor, self.syntax)
            default = None
            if cursor.eat("="):
                start = cursor.index
                cursor.skip_until([","])
                default = cursor.text_between(self.source, start, cursor.index)
            if not type_ref and default is not None:
                type_ref = _type_of_initializer(default)
            param_types[name] = type_ref or (_jsdoc_param(doc_raw, name) if doc_raw else None)
            if is_property:
                field = {"name": name, "type": type_ref, "optional": optional or default is not None}
                if default is not None:
                    literal = parse_literal(default)
                    if literal is not MISSING:
                        field["defaultValue"] = literal
                if apply_annotations(field, decorators):
                    fields.append(field)
            cursor.eat(",")
        cursor.eat(")")
        if not cursor.is_("{"):
            return fields
        # this.name = name; in the body
        body_start = cursor.index
        cursor.skip_group()
        body_end = cursor.index
        tokens = cursor.tokens
        for index in range(body_start, body_end - 3):
            if not (
                tokens[index].value == "this"
                and tokens[index + 1].value == "."
                and tokens[index + 2].kind == "ident"
                and tokens[index + 3].value == "="
            ):
                continue
            name = tokens[index + 2].value
            if any(field["name"] == name for field in fields):
                continue
            value_token = cursor.at(index + 4)
            type_ref = None
            if value_token is not None and value_token.kind == "ident" and value_token.value in param_types:
                type_ref = param_types[value_token.value]
            elif value_token is not None:
                end = index + 4
                while end < body_end and tokens[end].line == value_token.line and tokens[end].value != ";":
                    end += 1
                type_ref = _type_of_initializer(cursor.text_between(self.source, index + 4, end))
            fields.append({"name": name, "type": type_ref})
        return fields

    def _class(self, decorators: list[dict]) -> None:
        cursor = self.cursor
        doc = cursor.peek().doc
        cursor.next()
        name = self._reserve(cursor.next().value)
        model = {
            "name": name,
            "kind": "class",
            "fields": [],
            "generics": self._type_parameters(),
            "extends": self._heritage(),
        }
        if doc:
            model["description"] = doc
        if decorators:
            model["annotations"] = decorators
        if any(item["name"] in ("Entity", "ViewEntity") for item in decorators):
            model["kind"] = "entity"
            model["framework"] = "typeorm"
        model["construction"] = "properties"
        self.declarations["models"].append(model)
        # Class fields declared after the constructor still win over the constructor's assignments
        seen: set[str] = set()
        unique = []
        for field in self._members(name, True):
            if field["name"] not in seen:
                seen.add(field["name"])
                unique.append(field)
        model["fields"] = unique

    def _enum(self) -> None:
        cursor = self.cursor
        doc = cursor.peek().doc
        cursor.eat("const")
        cursor.next()
        name = self._reserve(cursor.next().value)
        item = {"name": name, "values": []}
        if doc:
            item["description"] = doc
        if not cursor.eat("{"):
            return
        following = 0
        while not cursor.done and not cursor.is_("}"):
            token = cursor.next()
            if token.kind not in ("ident", "string"):
                continue
            value = {"name": token.value}
            if cursor.eat("="):
                value_token = cursor.next()
                if value_token.kind == "string":
                    value["value"] = value_token.value
                elif value_token.kind == "number":
                    value["value"] = to_number(value_token.value)
                    following = value["value"] + 1 if value["value"] is not None else None
                elif value_token.value == "-" and cursor.peek() is not None and cursor.peek().kind == "number":
                    number = to_number(cursor.next().value)
                    value["value"] = -number if number is not None else None
                    following = value["value"] + 1 if value["value"] is not None else None
                cursor.skip_until([","])
            else:
                value["value"] = following
                following = following + 1 if following is not None else None
            item["values"].append(value)
            cursor.eat(",")
        cursor.eat("}")
        self.declarations["enums"].append(item)

    def _typedefs(self) -> None:
        """JSDoc @typedef {Object} User blocks with @property {string} [nickname] lines."""
        blocks: dict[str, None] = {}
        for token in self.cursor.tokens:
            if token.doc_raw is not None and "@typedef" in token.doc_raw:
                blocks[token.doc_raw] = None
        # Comments at the end of the file belong to no token
        for match in _TYPEDEF_BLOCK.finditer(self.source):
            if "@typedef" in match.group(0):
                blocks[match.group(0)] = None
        for block in blocks:
            header = _TYPEDEF.search(block)
            if not header or any(model["name"] == header.group(2) for model in self.declarations["models"]):
                continue
            fields = []
            for prop in _PROPERTY.finditer(block):
                if "." in prop.group(3):
                    continue
                field = {
                    "name": prop.group(3),
                    "type": _parse_jsdoc_type(prop.group(1)),
                    "optional": prop.group(2) == "[",
                }
                if prop.group(4) is not None:
                    literal = parse_literal(prop.group(4))
                    if literal is not MISSING:
                        field["defaultValue"] = literal
                description = trim(_COMMENT_END.sub("", prop.group(5) or ""))
                if description:
                    field["description"] = description
                fields.append(field)
            self.declarations["models"].append(
                {"name": self._reserve(header.group(2)), "kind": "type", "fields": fields}
            )


def _parse_script(text: str, javascript: bool) -> dict:
    if trim(text) == "":
        return failure("empty")
    try:
        tokens = tokenize(text, _LEXER)
    except LexError as error:
        return failure(error.code, position_at(text, error.index))
    reader = _Reader(text, tokens, javascript)
    declarations = reader.run()
    if ZodReader.uses(tokens):
        ZodReader(Cursor(tokens), text, declarations, reader.used_names).run()
    if not declarations["models"]:
        return failure("noModels")
    language = "javascript" if javascript else "typescript"
    built = build_schema(declarations, TYPESCRIPT_TYPES, language, language)
    return {"ok": True, "schema": built["schema"], "warnings": built["warnings"]}


_TS_DECLARATION = re.compile(r"^\s*(export\s+)?(declare\s+)?(interface|type)\s+\w+[\s<={]", re.MULTILINE | re.ASCII)
_TS_PRIMITIVE = re.compile(r":\s*(string|number|boolean)\b")
_TS_CLASS = re.compile(r"^\s*(export\s+)?(abstract\s+)?class\s+\w+", re.MULTILINE | re.ASCII)
_TS_PROPERTY = re.compile(r"\w[?!]?\s*:\s*(string|number|boolean|Date|[A-Z]\w*)(\[\])?\s*[;=\n]", re.ASCII)
_TS_ENUM = re.compile(r"^\s*(export\s+)?(const\s+)?enum\s+\w+\s*\{", re.MULTILINE | re.ASCII)
_ZOD = re.compile(r"\bz\.object\(")


def _detect_typescript(text: str) -> float:
    if _TS_DECLARATION.search(text):
        return 0.95 if _TS_PRIMITIVE.search(text) else 0.9
    if _TS_CLASS.search(text) and _TS_PROPERTY.search(text):
        return 0.85
    if _TS_ENUM.search(text):
        return 0.6
    if _ZOD.search(text):
        return 0.9
    return 0


_JS_TYPEDEF = re.compile(r"@typedef\s*\{")
_JS_CLASS = re.compile(r"^\s*(export\s+(default\s+)?)?class\s+\w+", re.MULTILINE | re.ASCII)
_JS_ASSIGNMENT = re.compile(r"this\.\w+\s*=", re.ASCII)
_JS_FIELD = re.compile(r"^\s+\w+\s*=\s*[^=]", re.MULTILINE | re.ASCII)


def _detect_javascript(text: str) -> float:
    if _JS_TYPEDEF.search(text):
        return 0.8
    if _JS_CLASS.search(text) and _JS_ASSIGNMENT.search(text):
        return 0.7
    if _JS_CLASS.search(text) and not _TS_PRIMITIVE.search(text) and _JS_FIELD.search(text):
        return 0.5
    return 0


typescript_parser = InputParser(
    "typescript",
    "code",
    "TypeScript",
    (".ts", ".tsx", ".mts", ".cts"),
    "typescript",
    _detect_typescript,
    lambda text, options=None: _parse_script(text, False),
)
javascript_parser = InputParser(
    "javascript",
    "code",
    "JavaScript",
    (".js", ".mjs", ".cjs", ".jsx"),
    "javascript",
    _detect_javascript,
    lambda text, options=None: _parse_script(text, True),
)
