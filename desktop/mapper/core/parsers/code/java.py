"""Java classes, records and enums, with JPA and Lombok annotations. Mirrors web/src/core/parsers/code/java.ts."""

import re

from ...js import to_number
from ...model.schema import primitive
from ..types import InputParser
from .annotations import apply_annotations, read_at_annotation
from .lexer import C_LIKE, Cursor, LexerConfig, StringRule
from .raw import MISSING, TypeTable, parse_declarations, parse_literal, raw
from .type_syntax import TypeSyntax, read_type

# Text blocks (Java 15)
_LEXER = LexerConfig(
    line_comments=C_LIKE.line_comments,
    block_comments=C_LIKE.block_comments,
    strings=(StringRule('"""', '"""', True, True), *C_LIKE.strings),
)

_SYNTAX = TypeSyntax(generics="<>", array_suffix=True)

JAVA_TYPES = TypeTable(
    primitives={
        "String": primitive("string"),
        "CharSequence": primitive("string"),
        "char": primitive("string"),
        "int": primitive("integer", 32),
        "long": primitive("integer", 64),
        "short": primitive("integer", 16),
        "byte": primitive("integer", 8),
        "BigInteger": primitive("integer"),
        "double": primitive("float", 64),
        "float": primitive("float", 32),
        "BigDecimal": primitive("decimal"),
        "boolean": primitive("boolean"),
        "LocalDate": primitive("date"),
        "LocalDateTime": primitive("datetime"),
        "OffsetDateTime": primitive("datetime"),
        "ZonedDateTime": primitive("datetime"),
        "Instant": primitive("datetime"),
        "Date": primitive("datetime"),
        "Timestamp": primitive("datetime"),
        "LocalTime": primitive("time"),
        "Duration": primitive("duration"),
        "UUID": primitive("uuid"),
        "byte[]": primitive("binary"),
        "Object": primitive("any"),
        "JsonNode": primitive("any"),
    },
    # Boxed types are chosen precisely because the value may be missing
    nullable_primitives={
        "Integer": primitive("integer", 32),
        "Long": primitive("integer", 64),
        "Short": primitive("integer", 16),
        "Byte": primitive("integer", 8),
        "Double": primitive("float", 64),
        "Float": primitive("float", 32),
        "Boolean": primitive("boolean"),
        "Character": primitive("string"),
    },
    lists=(
        "List",
        "ArrayList",
        "LinkedList",
        "Set",
        "HashSet",
        "TreeSet",
        "LinkedHashSet",
        "SortedSet",
        "Collection",
        "Iterable",
    ),
    maps=("Map", "HashMap", "TreeMap", "LinkedHashMap", "SortedMap", "ConcurrentHashMap"),
    optionals=("Optional",),
)

_MODIFIERS = {
    "public",
    "private",
    "protected",
    "static",
    "final",
    "abstract",
    "sealed",
    "non-sealed",
    "strictfp",
    "transient",
    "volatile",
    "default",
    "synchronized",
    "native",
}
_GETTER = re.compile(r"^(get|is)[A-Z]")
_SPACES = re.compile(r"\s+")


def _normalize(type_ref):
    """byte[] is binary data, not a list of numbers."""
    if not type_ref:
        return None
    args = type_ref["args"]
    if type_ref["name"] == "[]" and args and args[0]["name"] == "byte":
        return raw("byte[]")
    return {**type_ref, "args": [item for item in (_normalize(arg) for arg in args) if item]}


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "warnings": []}
        self.namespace: str | None = None
        # Classes being read, outermost first: a nested class is referred to as Outer.Inner
        self.enclosing: list[str] = []

    def run(self) -> dict:
        cursor = self.cursor
        while not cursor.done:
            if cursor.is_("package"):
                cursor.next()
                start = cursor.index
                cursor.skip_until([";"])
                self.namespace = _SPACES.sub("", cursor.text_between(self.source, start, cursor.index))
                cursor.eat(";")
                continue
            if cursor.is_("import"):
                cursor.skip_until([";"])
                cursor.eat(";")
                continue
            if not self._declaration():
                cursor.next()
        return self.declarations

    def _annotations_and_modifiers(self, modifiers: set | None, stop_at_annotation_type: bool) -> list[dict]:
        cursor = self.cursor
        annotations = []
        while True:
            if cursor.is_("@") and not (stop_at_annotation_type and cursor.is_("interface", 1)):
                annotation = read_at_annotation(cursor, self.source)
                if annotation:
                    annotations.append(annotation)
                else:
                    cursor.next()
            elif cursor.value() in _MODIFIERS:
                token = cursor.next()
                if modifiers is not None:
                    modifiers.add(token.value)
            else:
                return annotations

    def _declaration(self) -> bool:
        """Reads one type declaration (with its annotations and modifiers) at the cursor. Returns False when
        there is none, leaving the cursor where it was."""
        cursor = self.cursor
        start = cursor.index
        token = cursor.peek()
        doc = token.doc if token else None
        annotations = self._annotations_and_modifiers(None, True)
        keyword = cursor.value()
        if keyword in ("class", "record") and cursor.is_ident(1):
            cursor.next()
            self._class(keyword, annotations, doc)
            return True
        if keyword == "enum" and cursor.is_ident(1):
            cursor.next()
            self._enum(doc)
            return True
        if (keyword == "interface" or (keyword == "@" and cursor.is_("interface", 1))) and not cursor.done:
            # Interfaces and annotation types hold no data
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

    def _class(self, keyword: str, annotations: list[dict], doc) -> None:
        cursor = self.cursor
        name = cursor.next().value
        model = {
            "name": name,
            "kind": "record" if keyword == "record" else "class",
            "fields": [],
            "generics": self._type_parameters(),
        }
        if self.namespace:
            model["namespace"] = self.namespace
        if doc:
            model["description"] = doc
        if annotations:
            model["annotations"] = annotations
        names = {item["name"].split(".")[-1] for item in annotations}
        if names & {"Entity", "Embeddable", "MappedSuperclass"}:
            model["kind"] = "entity"
            model["framework"] = "jpa"
        metadata: dict = {}
        if keyword == "record":
            model["construction"] = "positional"
            model["fields"] = self._record_components()
        else:
            # Lombok's @Builder gives a builder; otherwise objects are filled with setters
            model["construction"] = "properties"
            if names & {"Builder", "SuperBuilder"}:
                metadata = {"builder": True}
        model["extends"] = []
        while not cursor.done and not cursor.is_("{"):
            if cursor.eat("extends"):
                parent = read_type(cursor, _SYNTAX)
                if parent:
                    model["extends"].append(parent["name"].split(".")[-1])
            else:
                cursor.next()
        self.declarations["models"].append(model)
        if self.enclosing:
            metadata = {**metadata, "outer": ".".join(self.enclosing)}
        self.enclosing.append(name)
        fields, getters, public_fields = self._body(name)
        self.enclosing.pop()
        model["fields"].extend(fields)
        # Records are read with name(); classes with getters unless they only expose public fields
        lombok = bool(names & {"Data", "Getter", "Value"})
        if keyword == "record":
            accessors = "record"
        elif not lombok and getters == 0 and public_fields > 0:
            accessors = "fields"
        else:
            accessors = "getters"
        model["metadata"] = {**metadata, "accessors": accessors}

    def _record_components(self) -> list[dict]:
        cursor = self.cursor
        fields: list[dict] = []
        if not cursor.eat("("):
            return fields
        while not cursor.done and not cursor.is_(")"):
            annotations = []
            while cursor.is_("@"):
                annotation = read_at_annotation(cursor, self.source)
                if not annotation:
                    break
                annotations.append(annotation)
            cursor.eat("final")
            type_start = cursor.index
            type_ref = _normalize(read_type(cursor, _SYNTAX))
            type_text = cursor.text_between(self.source, type_start, cursor.index)
            # Varargs: an array
            cursor.eat("...")
            if not cursor.is_ident():
                cursor.skip_until([","])
                cursor.eat(",")
                continue
            field = {"name": cursor.next().value, "type": type_ref, "typeText": type_text}
            if apply_annotations(field, annotations):
                fields.append(field)
            cursor.eat(",")
        cursor.eat(")")
        return fields

    def _body(self, owner: str) -> tuple[list[dict], int, int]:
        """Fields of a class body, and how many getters and public fields it has. Nested types are read as
        models of their own."""
        cursor = self.cursor
        fields: list[dict] = []
        getters = 0
        public_fields = 0
        if not cursor.eat("{"):
            return fields, getters, public_fields
        while not cursor.done and not cursor.is_("}"):
            if cursor.eat(";"):
                continue
            if cursor.is_("{"):
                # Initializer block
                cursor.skip_group()
                continue
            member_start = cursor.index
            if self._declaration():
                continue
            cursor.index = member_start
            doc = cursor.peek().doc
            modifiers: set[str] = set()
            annotations = self._annotations_and_modifiers(modifiers, False)
            if cursor.is_("<"):
                # Generic method
                self._type_parameters()
            # Constructor: Name(
            if cursor.is_(owner) and cursor.is_("(", 1):
                self._skip_method()
                continue
            type_start = cursor.index
            type_ref = _normalize(read_type(cursor, _SYNTAX))
            type_text = cursor.text_between(self.source, type_start, cursor.index)
            if not type_ref or not cursor.is_ident():
                cursor.skip_until([";", "}"])
                cursor.eat(";")
                continue
            if cursor.is_("(", 1):
                if _GETTER.match(cursor.value()) and cursor.is_(")", 2):
                    getters += 1
                self._skip_method()
                continue
            # int a, b = 2; declares several fields
            while True:
                name_token = cursor.next()
                field_type = type_ref
                while cursor.is_("[") and cursor.is_("]", 1):
                    cursor.next()
                    cursor.next()
                    field_type = raw("[]", [field_type])
                initializer = None
                if cursor.eat("="):
                    start = cursor.index
                    cursor.skip_until([",", ";"])
                    initializer = cursor.text_between(self.source, start, cursor.index)
                if "static" not in modifiers and "transient" not in modifiers:
                    field = {"name": name_token.value, "type": field_type, "typeText": type_text}
                    if doc:
                        field["description"] = doc
                    if initializer is not None:
                        literal = parse_literal(initializer)
                        if literal is not MISSING:
                            field["defaultValue"] = literal
                    if apply_annotations(field, annotations):
                        fields.append(field)
                        if "public" in modifiers:
                            public_fields += 1
                if cursor.eat(",") and cursor.is_ident():
                    continue
                break
            cursor.eat(";")
        cursor.eat("}")
        return fields, getters, public_fields

    def _skip_method(self) -> None:
        cursor = self.cursor
        while not cursor.done and not cursor.is_("("):
            cursor.next()
        cursor.skip_group()
        while not cursor.done and not cursor.is_("{") and not cursor.is_(";") and not cursor.is_("}"):
            cursor.next()
        if cursor.is_("{"):
            cursor.skip_group()
        else:
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
        while not cursor.done and not cursor.is_("}") and not cursor.is_(";"):
            while cursor.is_("@"):
                read_at_annotation(cursor, self.source)
            if not cursor.is_ident():
                cursor.next()
                continue
            value = {"name": cursor.next().value}
            # PAID("paid", 2): the first argument is usually the value on the wire
            if cursor.is_("("):
                first = cursor.peek(1)
                if first is not None and first.kind == "string":
                    value["value"] = first.value
                elif first is not None and first.kind == "number":
                    value["value"] = to_number(first.value)
                cursor.skip_group()
            if cursor.is_("{"):
                cursor.skip_group()
            item["values"].append(value)
            cursor.eat(",")
        # Fields and methods of the enum
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


_PACKAGE = re.compile(r"^\s*package\s+[\w.]+\s*;", re.MULTILINE | re.ASCII)
_TYPE_DECLARATION = re.compile(r"\b(public|private|protected)\s+(record|class|enum)\s+\w+", re.ASCII)
_FIELD_DECLARATION = re.compile(r"\b(private|public|protected)\s+[\w<>\[\], ?]+\s+\w+\s*[;=]", re.ASCII)
_RECORD = re.compile(r"^\s*(public\s+)?record\s+\w+\s*\(", re.MULTILINE | re.ASCII)
_ANNOTATIONS = re.compile(r"@(Entity|Data|Getter|Column|Id)\b")
_STATEMENT = re.compile(r";\s*$", re.MULTILINE)
_PROPERTY = re.compile(r"\{\s*get;")


def _detect(text: str) -> float:
    if _PACKAGE.search(text):
        return 0.95
    if _TYPE_DECLARATION.search(text) and _FIELD_DECLARATION.search(text):
        return 0.85
    if _RECORD.search(text):
        return 0.8
    if _ANNOTATIONS.search(text) and _STATEMENT.search(text) and not _PROPERTY.search(text):
        return 0.6
    return 0


def _parse(text: str, options: dict | None = None) -> dict:
    return parse_declarations(
        text, _LEXER, lambda source, tokens: _Reader(source, tokens).run(), JAVA_TYPES, "java", "java"
    )


java_parser = InputParser("java", "code", "Java", (".java",), "java", _detect, _parse)
