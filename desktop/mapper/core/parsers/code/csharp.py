"""C# classes, records, structs and enums, with Entity Framework and System.Text.Json attributes. Mirrors
web/src/core/parsers/code/csharp.ts."""

import re

from ...js import to_number, trim
from ...model.schema import primitive
from ..types import InputParser
from .annotations import apply_annotations, read_bracket_attributes
from .lexer import C_LIKE, Cursor, LexerConfig, StringRule
from .raw import MISSING, TypeTable, parse_declarations, parse_literal
from .type_syntax import TypeSyntax, read_type

# Raw string literals (C# 11), verbatim and interpolated strings
_LEXER = LexerConfig(
    line_comments=C_LIKE.line_comments,
    block_comments=C_LIKE.block_comments,
    strings=(StringRule('"""', '"""', False, True), *C_LIKE.strings),
    string_prefixes=re.compile(r"^(\$@|@\$|\$+|@)"),
)

_SYNTAX = TypeSyntax(generics="<>", array_suffix=True, nullable_suffix=True)

CSHARP_TYPES = TypeTable(
    primitives={
        "string": primitive("string"),
        "String": primitive("string"),
        "char": primitive("string"),
        "int": primitive("integer", 32),
        "Int32": primitive("integer", 32),
        "uint": primitive("integer", 32),
        "long": primitive("integer", 64),
        "Int64": primitive("integer", 64),
        "ulong": primitive("integer", 64),
        "short": primitive("integer", 16),
        "ushort": primitive("integer", 16),
        "byte": primitive("integer", 8),
        "sbyte": primitive("integer", 8),
        "BigInteger": primitive("integer"),
        "float": primitive("float", 32),
        "Single": primitive("float", 32),
        "double": primitive("float", 64),
        "Double": primitive("float", 64),
        "decimal": primitive("decimal"),
        "Decimal": primitive("decimal"),
        "bool": primitive("boolean"),
        "Boolean": primitive("boolean"),
        "DateTime": primitive("datetime"),
        "DateTimeOffset": primitive("datetime"),
        "DateOnly": primitive("date"),
        "TimeOnly": primitive("time"),
        "TimeSpan": primitive("duration"),
        "Guid": primitive("uuid"),
        "byte[]": primitive("binary"),
        "object": primitive("any"),
        "dynamic": primitive("any"),
        "JsonElement": primitive("any"),
        "JObject": primitive("any"),
    },
    lists=(
        "List",
        "IList",
        "ICollection",
        "IEnumerable",
        "IReadOnlyList",
        "IReadOnlyCollection",
        "HashSet",
        "ISet",
        "Collection",
        "ObservableCollection",
        "ImmutableList",
        "ImmutableArray",
    ),
    maps=("Dictionary", "IDictionary", "IReadOnlyDictionary", "SortedDictionary", "ImmutableDictionary"),
    optionals=("Nullable",),
)

_MODIFIERS = {
    "public",
    "private",
    "protected",
    "internal",
    "static",
    "readonly",
    "virtual",
    "override",
    "abstract",
    "sealed",
    "partial",
    "required",
    "new",
    "const",
    "volatile",
    "unsafe",
    "extern",
    "async",
    "file",
}
_SETTER = re.compile(r"\b(set|init)\b")
_COMPUTED_GETTER = re.compile(r"\bget\s*(=>|\{)")
_SILENCED = re.compile(r"(null|default)!")
_GENERATED = re.compile(r"Identity|Computed")
_SPACES = re.compile(r"\s+")


def _normalize(type_ref):
    if not type_ref:
        return None
    args = type_ref["args"]
    if type_ref["name"] == "[]" and args and args[0]["name"] == "byte":
        result = {"name": "byte[]", "args": []}
        if "nullable" in type_ref:
            result["nullable"] = type_ref["nullable"]
        return result
    return {**type_ref, "args": [item for item in (_normalize(arg) for arg in args) if item]}


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "warnings": []}
        self.namespace: str | None = None

    def run(self) -> dict:
        cursor = self.cursor
        while not cursor.done:
            if cursor.is_("using") and not cursor.is_("(", 1):
                cursor.skip_until([";"])
                cursor.eat(";")
                continue
            if cursor.is_("namespace"):
                cursor.next()
                start = cursor.index
                while not cursor.done and not cursor.is_(";") and not cursor.is_("{"):
                    cursor.next()
                self.namespace = _SPACES.sub("", cursor.text_between(self.source, start, cursor.index))
                # File-scoped (namespace A;) or block (namespace A { … }): declarations inside are read the same way
                cursor.next()
                continue
            if not self._declaration():
                cursor.next()
        return self.declarations

    def _attributes(self, modifiers: set | None) -> list[dict]:
        cursor = self.cursor
        attributes: list[dict] = []
        while True:
            if cursor.is_("["):
                attributes.extend(read_bracket_attributes(cursor, self.source))
            elif cursor.value() in _MODIFIERS:
                token = cursor.next()
                if modifiers is not None:
                    modifiers.add(token.value)
            else:
                return attributes

    def _declaration(self) -> bool:
        cursor = self.cursor
        start = cursor.index
        token = cursor.peek()
        doc = token.doc if token else None
        attributes = self._attributes(None)
        keyword = cursor.value()
        if keyword == "record" and (cursor.is_("struct", 1) or cursor.is_("class", 1)):
            cursor.next()
        if keyword in ("class", "struct", "record") and cursor.is_ident(1):
            cursor.next()
            if cursor.value() in ("struct", "class"):
                keyword = "record"
            self._type(keyword, attributes, doc)
            return True
        if keyword == "enum" and cursor.is_ident(1):
            cursor.next()
            self._enum(doc)
            return True
        if keyword == "interface" and cursor.is_ident(1):
            while not cursor.done and not cursor.is_("{"):
                cursor.next()
            cursor.skip_group()
            return True
        cursor.index = start
        return False

    def _type_parameters(self) -> list[str]:
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

    def _type(self, keyword: str, attributes: list[dict], doc) -> None:
        cursor = self.cursor
        if cursor.is_("struct") or cursor.is_("class"):
            cursor.next()
        name = cursor.next().value
        kind = "record" if keyword == "record" else "struct" if keyword == "struct" else "class"
        model = {
            "name": name,
            "kind": kind,
            "fields": [],
            "generics": self._type_parameters(),
            "construction": "properties",
        }
        if self.namespace:
            model["namespace"] = self.namespace
        if doc:
            model["description"] = doc
        if attributes:
            model["annotations"] = attributes
        if cursor.is_("("):
            model["fields"] = self._parameters()
            model["construction"] = "positional"
        parents: list[str] = []
        if cursor.eat(":"):
            while True:
                parent = read_type(cursor, _SYNTAX)
                if parent:
                    parents.append(parent["name"].split(".")[-1])
                if cursor.is_("("):
                    cursor.skip_group()
                if not cursor.eat(","):
                    break
        model["extends"] = parents
        while not cursor.done and not cursor.is_("{") and not cursor.is_(";"):
            cursor.next()
        if "DbContext" in parents or "IdentityDbContext" in parents:
            # The context lists the tables (DbSet<User>); it is not a model itself
            cursor.skip_group()
            return
        if any(item["name"] in ("Table", "Index", "PrimaryKey") for item in attributes):
            model["kind"] = "entity"
            model["framework"] = "efcore"
        self.declarations["models"].append(model)
        if cursor.eat(";"):
            return
        model["fields"].extend(self._body(name))
        if any(
            any(item["name"] in ("Key", "ForeignKey") for item in field.get("annotations") or [])
            for field in model["fields"]
        ):
            model["kind"] = "entity"
            model["framework"] = "efcore"

    def _parameters(self) -> list[dict]:
        """Positional record parameters: record User(int Id, [property: JsonPropertyName("n")] string Name)."""
        cursor = self.cursor
        fields: list[dict] = []
        cursor.next()
        while not cursor.done and not cursor.is_(")"):
            attributes: list[dict] = []
            while cursor.is_("["):
                attributes.extend(read_bracket_attributes(cursor, self.source))
            type_start = cursor.index
            type_ref = _normalize(read_type(cursor, _SYNTAX))
            type_text = cursor.text_between(self.source, type_start, cursor.index)
            if not cursor.is_ident():
                cursor.skip_until([","])
                cursor.eat(",")
                continue
            field = {"name": cursor.next().value, "type": type_ref, "typeText": type_text}
            if cursor.eat("="):
                start = cursor.index
                cursor.skip_until([","])
                literal = parse_literal(cursor.text_between(self.source, start, cursor.index))
                if literal is not MISSING:
                    field["defaultValue"] = literal
                field["optional"] = True
            if apply_annotations(field, attributes):
                fields.append(field)
            cursor.eat(",")
        cursor.eat(")")
        return fields

    def _body(self, owner: str) -> list[dict]:
        cursor = self.cursor
        fields: list[dict] = []
        if not cursor.eat("{"):
            return fields
        while not cursor.done and not cursor.is_("}"):
            if cursor.eat(";"):
                continue
            member_start = cursor.index
            if self._declaration():
                continue
            cursor.index = member_start
            doc = cursor.peek().doc
            modifiers: set[str] = set()
            attributes = self._attributes(modifiers)
            if (cursor.is_(owner) or cursor.is_("~")) and (cursor.is_("(", 1) or cursor.is_(owner, 1)):
                self._skip_member()
                continue
            if any(cursor.is_(word) for word in ("event", "delegate", "operator", "implicit", "explicit")):
                self._skip_member()
                continue
            type_start = cursor.index
            type_ref = _normalize(read_type(cursor, _SYNTAX))
            type_text = cursor.text_between(self.source, type_start, cursor.index)
            if not type_ref or not cursor.is_ident():
                self._skip_member()
                continue
            name_token = cursor.next()
            if cursor.is_("(") or cursor.is_("<") or cursor.is_("."):
                cursor.index -= 1
                self._skip_member()
                continue
            field = {"name": name_token.value, "type": type_ref, "typeText": type_text}
            if doc:
                field["description"] = doc
            computed = False
            accessors = False
            if cursor.is_("{"):
                accessors = True
                # Property accessors: { get; set; }, { get; init; }, { get => _x; }
                accessors_start = cursor.index
                cursor.skip_group()
                text = cursor.text_between(self.source, accessors_start, cursor.index)
                if not _SETTER.search(text) or _COMPUTED_GETTER.search(text):
                    computed = True
            elif cursor.is_("=>"):
                computed = True
            initialized = cursor.eat("=")
            if initialized:
                start = cursor.index
                cursor.skip_until([";"])
                text = cursor.text_between(self.source, start, cursor.index)
                literal = parse_literal(text)
                # = null! and = default! only silence the compiler: they are not real defaults
                if literal is not MISSING and literal is not None:
                    field["defaultValue"] = literal
                if not _SILENCED.fullmatch(trim(text)) and "required" not in modifiers:
                    field["optional"] = True
            # A property's accessors end it, unless an initializer follows
            if not accessors or initialized:
                self._skip_member()
            if "static" in modifiers or "const" in modifiers or computed:
                continue
            # Members are private unless declared otherwise: only the public surface is the model
            if "public" not in modifiers and "internal" not in modifiers:
                continue
            if not apply_annotations(field, attributes):
                continue
            # Entity Framework fills in an integer key called Id or <Class>Id
            if any(
                item["name"] == "DatabaseGenerated" and _GENERATED.search(item.get("args") or "") for item in attributes
            ):
                field["generated"] = True
            fields.append(field)
        cursor.eat("}")
        return fields

    def _skip_member(self) -> None:
        """Skips the rest of a member: up to ; or the end of its body."""
        cursor = self.cursor
        while not cursor.done and not cursor.is_(";") and not cursor.is_("}"):
            if cursor.is_("{") or cursor.is_("(") or cursor.is_("["):
                was_body = cursor.is_("{")
                cursor.skip_group()
                # A method body ends the member unless an initializer follows ({ get; } = 5;)
                if was_body and not cursor.is_("="):
                    return
                continue
            cursor.next()
        cursor.eat(";")

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
        following = 0
        while not cursor.done and not cursor.is_("}"):
            if cursor.is_("["):
                read_bracket_attributes(cursor, self.source)
                continue
            if not cursor.is_ident():
                cursor.next()
                continue
            value = {"name": cursor.next().value}
            if cursor.eat("="):
                token = cursor.next()
                if token.kind == "number":
                    following = to_number(token.value)
                cursor.skip_until([","])
            value["value"] = following
            following = following + 1 if following is not None else None
            item["values"].append(value)
            cursor.eat(",")
        cursor.eat("}")
        self.declarations["enums"].append(item)


_PROPERTY = re.compile(r"\{\s*get;\s*(set|init);?\s*\}")
_NAMESPACE = re.compile(r"^\s*namespace\s+[\w.]+\s*[;{]", re.MULTILINE | re.ASCII)
_USING = re.compile(r"^\s*using\s+System", re.MULTILINE)
_RECORD = re.compile(r"\b(public\s+)?(sealed\s+)?record\s+\w+\s*\(", re.ASCII)
_COMMON_TYPES = re.compile(r"\b(string|int|Guid|DateTime|decimal)\b")


def _detect(text: str) -> float:
    if _PROPERTY.search(text):
        return 0.95
    if _NAMESPACE.search(text) or _USING.search(text):
        return 0.9
    if _RECORD.search(text) and _COMMON_TYPES.search(text):
        return 0.7
    return 0


def _parse(text: str, options: dict | None = None) -> dict:
    return parse_declarations(
        text, _LEXER, lambda source, tokens: _Reader(source, tokens).run(), CSHARP_TYPES, "csharp", "csharp"
    )


csharp_parser = InputParser("csharp", "code", "C#", (".cs",), "csharp", _detect, _parse)
