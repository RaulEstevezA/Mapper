"""Python classes: dataclasses, Pydantic, TypedDict, attrs, Django and SQLAlchemy models, enums and plain
classes with __init__. Mirrors web/src/core/parsers/code/python.ts."""

import json
import re

from ...js import coalesce, is_number, json_string, to_number, trim
from ...model.naming import to_pascal_case
from ...model.schema import primitive
from ..types import InputParser
from .annotations import annotation_arg, read_at_annotation
from .lexer import Cursor, LexerConfig, StringRule
from .raw import MISSING, TypeTable, parse_declarations, parse_literal, raw
from .type_syntax import TypeSyntax, read_type

_LEXER = LexerConfig(
    line_comments=("#",),
    strings=(
        StringRule('"""', '"""', True, True),
        StringRule("'''", "'''", True, True),
        StringRule('"', '"', True, False),
        StringRule("'", "'", True, False),
    ),
    string_prefixes=re.compile(r"^(rb|br|fr|rf|Rb|bR|[rbfuRBFU])"),
)

_SYNTAX = TypeSyntax(generics="[]", unions=True)

PYTHON_TYPES = TypeTable(
    primitives={
        "str": primitive("string"),
        "EmailStr": primitive("string"),
        "HttpUrl": primitive("string"),
        "AnyUrl": primitive("string"),
        "SecretStr": primitive("string"),
        "constr": primitive("string"),
        "int": primitive("integer"),
        "PositiveInt": primitive("integer"),
        "NonNegativeInt": primitive("integer"),
        "conint": primitive("integer"),
        "float": primitive("float"),
        "PositiveFloat": primitive("float"),
        "confloat": primitive("float"),
        "Decimal": primitive("decimal"),
        "condecimal": primitive("decimal"),
        "bool": primitive("boolean"),
        "StrictBool": primitive("boolean"),
        "bytes": primitive("binary"),
        "bytearray": primitive("binary"),
        "datetime": primitive("datetime"),
        "AwareDatetime": primitive("datetime"),
        "date": primitive("date"),
        "time": primitive("time"),
        "timedelta": primitive("duration"),
        "UUID": primitive("uuid"),
        "UUID4": primitive("uuid"),
        "Any": primitive("any"),
        "object": primitive("any"),
        "Json": primitive("any"),
    },
    lists=(
        "list",
        "List",
        "Sequence",
        "MutableSequence",
        "set",
        "Set",
        "frozenset",
        "FrozenSet",
        "tuple",
        "Tuple",
        "Iterable",
        "Collection",
    ),
    maps=("dict", "Dict", "Mapping", "MutableMapping", "DefaultDict", "OrderedDict"),
    optionals=("Optional",),
    transparent=("Mapped", "Annotated", "Final", "Required", "ReadOnly", "NotRequired"),
    null_names=("None", "NoneType"),
)

_ENUM_BASES = {"Enum", "IntEnum", "StrEnum", "Flag", "IntFlag", "TextChoices", "IntegerChoices", "Choices"}

# Django field classes and the Python type they hold
_DJANGO_FIELDS = {
    "CharField": "str",
    "TextField": "str",
    "SlugField": "str",
    "EmailField": "str",
    "URLField": "str",
    "GenericIPAddressField": "str",
    "FilePathField": "str",
    "FileField": "str",
    "ImageField": "str",
    "IntegerField": "int",
    "SmallIntegerField": "int",
    "BigIntegerField": "int",
    "PositiveIntegerField": "int",
    "PositiveSmallIntegerField": "int",
    "PositiveBigIntegerField": "int",
    "AutoField": "int",
    "BigAutoField": "int",
    "SmallAutoField": "int",
    "FloatField": "float",
    "DecimalField": "Decimal",
    "BooleanField": "bool",
    "NullBooleanField": "bool",
    "DateTimeField": "datetime",
    "DateField": "date",
    "TimeField": "time",
    "DurationField": "timedelta",
    "UUIDField": "UUID",
    "BinaryField": "bytes",
    "JSONField": "Any",
}

# SQLAlchemy column types
_SQLALCHEMY_TYPES = {
    "String": "str",
    "Text": "str",
    "Unicode": "str",
    "UnicodeText": "str",
    "VARCHAR": "str",
    "Integer": "int",
    "SmallInteger": "int",
    "BigInteger": "int",
    "Float": "float",
    "Numeric": "Decimal",
    "DECIMAL": "Decimal",
    "Boolean": "bool",
    "DateTime": "datetime",
    "Date": "date",
    "Time": "time",
    "Interval": "timedelta",
    "Uuid": "UUID",
    "UUID": "UUID",
    "LargeBinary": "bytes",
    "JSON": "Any",
    "Enum": "str",
}

_NAME = re.compile(r"[\w.]+", re.ASCII)
_CALL = re.compile(r"([\w.]+)\s*\(", re.ASCII)
_POSITIONAL = re.compile(r"\s*([^=,]+?)\s*(,|\Z)")
_RELATED = re.compile(r"\s*['\"]?([\w.]+)['\"]?", re.ASCII)
_COLUMN_TYPE = re.compile(r"\s*(?:['\"][\w]+['\"]\s*,\s*)?([A-Za-z_][\w.]*)", re.ASCII)
_COLUMN_NAME = re.compile(r"\s*['\"]([\w]+)['\"]", re.ASCII)
_ON_UPDATE = re.compile(r"onupdate|server_default\s*=\s*func\.")
_DATACLASS = re.compile(r"(dataclasses\.)?dataclass")
_NOT_FIELDS = ("def", "class", "async", "pass", "return", "if", "for", "with", "from", "import")


def _normalize(type_ref):
    """Python writes Union[A, None], Literal['a', 'b'] and forward references as strings ("User"); they are
    turned into the common forms."""
    if not type_ref:
        return None
    simple = type_ref["name"].split(".")[-1]
    if simple == "Literal":
        return raw(
            "|",
            [
                {**arg, "name": arg["name"] if arg["name"].startswith('"') else json_string(arg["name"])}
                for arg in type_ref["args"]
            ],
        )
    args = [item for item in (_normalize(arg) for arg in type_ref["args"]) if item]
    if simple == "Union":
        return raw("|", args)
    if type_ref["name"].startswith('"'):
        inner = json.loads(type_ref["name"])
        if _NAME.fullmatch(inner):
            return raw(inner)
    return {**type_ref, "args": args}


def _type_of_literal(literal) -> str:
    if isinstance(literal, str):
        return "str"
    if isinstance(literal, bool):
        return "bool"
    return "int" if isinstance(literal, int) else "float"


class _Reader:
    def __init__(self, source: str, tokens: list):
        self.source = source
        self.cursor = Cursor(tokens)
        self.declarations = {"models": [], "enums": [], "aliases": {}, "warnings": []}

    def _statement_end(self, start: int) -> int:
        """End (exclusive) of the logical line starting at start: brackets continue it across lines."""
        tokens = self.cursor.tokens
        depth = 0
        index = start
        while index < len(tokens):
            token = tokens[index]
            if index > start and depth == 0 and token.line_start:
                break
            if token.kind == "punct":
                if token.value in "([{":
                    depth += 1
                elif token.value in ")]}":
                    depth = max(0, depth - 1)
            index += 1
        return index

    def _block(self, start: int, parent_column: int) -> list[tuple[int, int]]:
        """Statements of a block, as (start, end): those starting at the block's indentation, after start."""
        tokens = self.cursor.tokens
        statements: list[tuple[int, int]] = []
        if start >= len(tokens) or tokens[start].column <= parent_column:
            return statements
        column = tokens[start].column
        index = start
        while index < len(tokens):
            token = tokens[index]
            if token.line_start and token.column <= parent_column:
                break
            end = self._statement_end(index)
            if token.column == column:
                statements.append((index, end))
            index = end
        return statements

    def run(self) -> dict:
        tokens = self.cursor.tokens
        decorators: list[dict] = []
        index = 0
        while index < len(tokens):
            token = tokens[index]
            if token.value == "@" and token.line_start:
                self.cursor.index = index
                decorator = read_at_annotation(self.cursor, self.source)
                if decorator:
                    decorators.append(decorator)
                index = self._statement_end(index)
                continue
            following = self.cursor.at(index + 1)
            if token.value == "class" and token.kind == "ident" and following is not None and following.kind == "ident":
                index = self._class(index, decorators)
                decorators = []
                continue
            decorators = []
            index = self._statement_end(index)
        return self.declarations

    def _class(self, start: int, decorators: list[dict]) -> int:
        tokens = self.cursor.tokens
        class_token = tokens[start]
        name = tokens[start + 1].value
        cursor = self.cursor
        cursor.index = start + 2
        bases: list[dict] = []
        if cursor.is_("("):
            cursor.next()
            while not cursor.done and not cursor.is_(")"):
                if cursor.is_ident() and cursor.is_("=", 1):
                    keyword = cursor.next().value
                    cursor.next()
                    bases.append({"name": "", "keyword": keyword, "value": cursor.value()})
                    cursor.skip_until([","])
                else:
                    type_ref = read_type(cursor, _SYNTAX)
                    if type_ref:
                        bases.append({"name": type_ref["name"]})
                    else:
                        cursor.next()
                cursor.eat(",")
            cursor.eat(")")
        cursor.eat(":")
        header_end = self._statement_end(start)
        # class A: pass on one line
        if cursor.index < header_end:
            return header_end

        statements = self._block(header_end, class_token.column)
        end = statements[-1][1] if statements else header_end
        description = None
        if statements and tokens[statements[0][0]].kind == "string" and statements[0][1] == statements[0][0] + 1:
            description = trim(tokens[statements[0][0]].value).split("\n")[0]

        base_names = [base["name"].split(".")[-1] for base in bases]
        if any(base in _ENUM_BASES for base in base_names):
            self._enum(name, statements, description)
            return end

        model = {"name": name, "kind": "class", "fields": [], "construction": "named"}
        if description:
            model["description"] = description
        if decorators:
            model["annotations"] = decorators
        model["extends"] = [base["name"] for base in bases if base["name"] != ""]

        framework = None
        if any(_DATACLASS.fullmatch(item["name"]) or item["name"] in ("attr.s", "define") for item in decorators):
            framework = "dataclass"
        if any(base in ("BaseModel", "BaseSettings", "SQLModel") for base in base_names):
            framework = "pydantic"
        if "TypedDict" in base_names:
            framework = "typeddict"
            model["kind"] = "typeddict"
        if "Model" in base_names and any(base["name"] == "models.Model" for base in bases):
            framework = "django"
        if any(base in ("Base", "DeclarativeBase") for base in base_names):
            framework = "sqlalchemy"
        if framework in ("django", "sqlalchemy"):
            model["kind"] = "entity"
        if framework:
            model["framework"] = framework
        total_base = next((base for base in bases if base.get("keyword") == "total"), None)
        total = (total_base["value"] if total_base else None) != "False"

        for statement in statements:
            self._member(statement, model, framework, total)
        if framework == "django" and not any(
            (field.get("metadata") or {}).get("primaryKey") for field in model["fields"]
        ):
            # Django adds an id primary key to every model that declares none
            model["fields"].insert(
                0, {"name": "id", "type": raw("int"), "generated": True, "metadata": {"primaryKey": True}}
            )
        self.declarations["models"].append(model)
        return end

    def _member(self, statement: tuple[int, int], model: dict, framework, total: bool) -> None:
        tokens = self.cursor.tokens
        cursor = self.cursor
        start, statement_end = statement
        first = tokens[start]
        following = cursor.at(start + 1)
        if first.value == "def" and following is not None and following.value == "__init__":
            self._initializer(statement, model)
            return
        if first.kind != "ident" or first.value in _NOT_FIELDS:
            return
        if first.value.startswith("__") or first.value in ("model_config", "Config", "Meta", "objects"):
            return

        cursor.index = start + 1
        type_ref = None
        type_text = None
        if cursor.eat(":"):
            type_start = cursor.index
            type_ref = _normalize(read_type(cursor, _SYNTAX))
            type_text = cursor.text_between(self.source, type_start, cursor.index)
            if type_ref and type_ref["name"] in ("ClassVar", "typing.ClassVar"):
                return
        elif not cursor.is_("="):
            return
        field = {"name": first.value, "type": self._literal_enum(type_ref, first.value)}
        if type_text:
            field["typeText"] = type_text
        if first.doc:
            field["description"] = first.doc

        # TypedDict: missing keys are allowed when total=False or with NotRequired[...]
        if framework == "typeddict":
            annotation = type_text or ""
            if not total or annotation.startswith("NotRequired["):
                field["optional"] = True

        if cursor.eat("="):
            value_start = cursor.index
            value_text = cursor.text_between(self.source, value_start, statement_end)
            call = _CALL.match(value_text)
            if call:
                callee = call.group(1).split(".")[-1]
                cursor.index = value_start
                while cursor.index < statement_end and not cursor.is_("("):
                    cursor.next()
                args_start = cursor.index
                cursor.skip_group()
                args = cursor.text_between(self.source, args_start, cursor.index)[1:-1]
                if not self._call_initializer(field, {"name": callee, "args": args}, framework, callee):
                    return
            else:
                literal = parse_literal(value_text)
                if literal is not MISSING:
                    field["defaultValue"] = literal
                # Without an annotation, a plain class attribute is typed by its value
                if not type_ref and literal is not MISSING and literal is not None:
                    field["type"] = raw(_type_of_literal(literal))
                if literal is None and not type_ref:
                    field["type"] = {"name": "Any", "args": [], "nullable": True}
                if trim(value_text) != "" and framework != "typeddict":
                    field["optional"] = True
        if not field["type"] and not type_ref:
            return
        model["fields"].append(field)

    def _call_initializer(self, field: dict, call: dict, framework, callee: str) -> bool:
        """= Field(...), = field(...), = models.CharField(...), = Column(...), = mapped_column(...). Returns False
        when the attribute is not a field (a relationship back-reference, a manager)."""
        args = call.get("args") or ""

        def keyword(name: str):
            return annotation_arg(call, name)

        def has_keyword(name: str) -> bool:
            return re.search(rf"(^|[\s,(]){name}\s*=", args) is not None

        field["annotations"] = [call]

        if callee in ("Field", "field"):
            alias = coalesce(keyword("alias"), keyword("serialization_alias"), keyword("validation_alias"))
            if alias:
                field["serializedName"] = alias
            default_text = keyword("default")
            match = _POSITIONAL.match(args)
            positional = match.group(1) if match else None
            default = coalesce(default_text, positional if positional and positional != "..." else None)
            if default is not None:
                literal = parse_literal(default)
                if literal is not MISSING:
                    field["defaultValue"] = literal
                field["optional"] = True
            if has_keyword("default_factory"):
                field["optional"] = True
            description = keyword("description")
            if description:
                field["description"] = description
            return True

        if (
            framework == "django"
            or callee in _DJANGO_FIELDS
            or callee in ("ForeignKey", "OneToOneField", "ManyToManyField")
        ):
            if callee in ("ForeignKey", "OneToOneField", "ManyToManyField"):
                match = _RELATED.match(args)
                target = match.group(1).split(".")[-1] if match else "Any"
                field["type"] = raw("list", [raw(target)]) if callee == "ManyToManyField" else raw(target)
            elif callee in _DJANGO_FIELDS:
                if field["type"] is None:
                    field["type"] = raw(_DJANGO_FIELDS[callee])
            elif callee == "Manager":
                return False
            if keyword("null") == "True":
                field["nullable"] = True
            if keyword("blank") == "True" or has_keyword("default"):
                field["optional"] = True
            default_text = keyword("default")
            if default_text is not None:
                literal = parse_literal(default_text)
                if literal is not MISSING:
                    field["defaultValue"] = literal
            if keyword("primary_key") == "True":
                field["metadata"] = {"primaryKey": True}
            if callee.endswith("AutoField") or keyword("auto_now") == "True" or keyword("auto_now_add") == "True":
                field["generated"] = True
            column = keyword("db_column")
            if column:
                field["serializedName"] = column
            return field["type"] is not None

        if callee in ("Column", "mapped_column"):
            # Column(String(50), …) or mapped_column(String(50), …); the type may also come from Mapped[...]
            match = _COLUMN_TYPE.match(args)
            type_name = match.group(1).split(".")[-1] if match else None
            if not field["type"] and type_name and type_name in _SQLALCHEMY_TYPES:
                field["type"] = raw(_SQLALCHEMY_TYPES[type_name])
            nullable = keyword("nullable")
            primary_key = keyword("primary_key") == "True"
            if callee == "Column":
                field["nullable"] = nullable == "True" or (nullable is None and not primary_key)
            elif nullable == "True":
                field["nullable"] = True
            elif nullable == "False" and field["type"]:
                field["type"] = {**field["type"], "nullable": False}
            if primary_key:
                field["metadata"] = {"primaryKey": True}
                if keyword("autoincrement") != "False" and field["type"] and field["type"]["name"] == "int":
                    field["generated"] = True
            if has_keyword("server_default") or has_keyword("default"):
                field["optional"] = True
            if _ON_UPDATE.search(args) and "func.now" in args:
                field["generated"] = True
            match = _COLUMN_NAME.match(args)
            column = coalesce(match.group(1) if match else None, keyword("name"))
            if column:
                field["serializedName"] = column
            return field["type"] is not None

        if callee == "relationship":
            return field["type"] is not None
        # Any other call: an initial value computed at run time
        field["optional"] = True
        return field["type"] is not None

    def _initializer(self, statement: tuple[int, int], model: dict) -> None:
        """Fields assigned in __init__ (self.name = name), typed by the parameters' annotations."""
        tokens = self.cursor.tokens
        cursor = self.cursor
        start = statement[0]
        cursor.index = start + 2
        params: dict[str, dict] = {}
        if cursor.eat("("):
            while not cursor.done and not cursor.is_(")"):
                if cursor.is_("*") or cursor.is_("/"):
                    cursor.next()
                    cursor.eat(",")
                    continue
                if not cursor.is_ident():
                    cursor.next()
                    continue
                name = cursor.next().value
                type_ref = _normalize(read_type(cursor, _SYNTAX)) if cursor.eat(":") else None
                default = None
                if cursor.eat("="):
                    value_start = cursor.index
                    cursor.skip_until([","])
                    default = cursor.text_between(self.source, value_start, cursor.index)
                if name != "self":
                    params[name] = {"type": type_ref, "default": default}
                cursor.eat(",")
        # The body follows the signature
        index = self._statement_end(start)
        while index < len(tokens) - 3:
            token = tokens[index]
            if token.line_start and token.column <= tokens[start].column:
                break
            if token.value != "self" or tokens[index + 1].value != "." or tokens[index + 2].kind != "ident":
                index += 1
                continue
            name = tokens[index + 2].value
            position = index + 3
            type_ref = None
            if cursor.at(position) is not None and tokens[position].value == ":":
                cursor.index = position + 1
                type_ref = _normalize(read_type(cursor, _SYNTAX))
                position = cursor.index
            assigned = cursor.at(position)
            if assigned is None or assigned.value != "=" or any(field["name"] == name for field in model["fields"]):
                index += 1
                continue
            value = cursor.at(position + 1)
            param = params.get(value.value) if value is not None and value.kind == "ident" else None
            field = {"name": name, "type": type_ref or (param["type"] if param else None)}
            if param and param["default"] is not None:
                field["optional"] = True
                literal = parse_literal(param["default"])
                if literal is not MISSING:
                    field["defaultValue"] = literal
            if not field["type"] and value is not None:
                literal = parse_literal(json_string(value.value) if value.kind == "string" else value.value)
                if isinstance(literal, str):
                    field["type"] = raw("str")
                elif is_number(literal):
                    field["type"] = raw("int" if isinstance(literal, int) else "float")
                elif isinstance(literal, bool):
                    field["type"] = raw("bool")
            index += 1
            if name.startswith("_"):
                continue
            model["fields"].append(field)

    def _literal_enum(self, type_ref, field_name: str):
        """status: Literal['active', 'blocked'] creates an enum named after the field."""
        if not type_ref or type_ref["name"] != "|":
            return type_ref
        literals = [arg for arg in type_ref["args"] if arg["name"].startswith('"')]
        others = [arg for arg in type_ref["args"] if not arg["name"].startswith('"')]
        if len(literals) < 2 or any(arg["name"] != "None" for arg in others):
            return type_ref
        used = {item["name"] for item in self.declarations["enums"]} | {
            item["name"] for item in self.declarations["models"]
        }
        base = to_pascal_case(field_name) or "Value"
        name = base
        n = 2
        while name in used:
            name = f"{name}{n}"
            n += 1
        self.declarations["enums"].append(
            {"name": name, "kind": "literals", "values": [{"name": json.loads(arg["name"])} for arg in literals]}
        )
        enum_type = raw(name)
        return raw("|", [enum_type, *others]) if others else enum_type

    def _enum(self, name: str, statements: list[tuple[int, int]], description) -> None:
        cursor = self.cursor
        tokens = cursor.tokens
        item = {"name": name, "values": []}
        if description:
            item["description"] = description
        auto = 1
        for start, _ in statements:
            first = tokens[start]
            assign = cursor.at(start + 1)
            if first.kind != "ident" or assign is None or assign.value != "=" or first.value.startswith("_"):
                continue
            value = cursor.at(start + 2)
            entry = {"name": first.value}
            if value is not None and value.kind == "string":
                entry["value"] = value.value
            elif value is not None and value.kind == "number":
                entry["value"] = to_number(value.value)
            elif value is not None and value.value == "auto":
                entry["value"] = auto
                auto += 1
            # Django choices: ACTIVE = 'A', 'Active'
            item["values"].append(entry)
        self.declarations["enums"].append(item)


_CLASS = re.compile(r"^class\s+\w+(\([^)]*\))?\s*:\s*$", re.MULTILINE)
_ANNOTATED = re.compile(r"^\s+\w+\s*:\s*[\w\[\]., |\"']+(\s*=.*)?$", re.MULTILINE)
_IMPORT = re.compile(r"^from\s+[\w.]+\s+import\s+", re.MULTILINE)
_DATACLASS_LINE = re.compile(r"^@dataclass", re.MULTILINE)
_DJANGO = re.compile(r"models\.\w+Field")


def _detect(text: str) -> float:
    if _CLASS.search(text):
        if _ANNOTATED.search(text) or "def __init__" in text or _DJANGO.search(text):
            return 0.95
        return 0.7
    if _IMPORT.search(text) or _DATACLASS_LINE.search(text):
        return 0.6
    return 0


def _parse(text: str, options: dict | None = None) -> dict:
    return parse_declarations(
        text, _LEXER, lambda source, tokens: _Reader(source, tokens).run(), PYTHON_TYPES, "python", "python"
    )


python_parser = InputParser("python", "code", "Python", (".py", ".pyi"), "python", _detect, _parse)
