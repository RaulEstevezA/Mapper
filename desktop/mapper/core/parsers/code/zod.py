"""Zod schemas in TypeScript (export const UserSchema = z.object({ … })), as Api2Class writes them with its Zod
style. Mirrors web/src/core/parsers/code/zod.ts. They are read as tokens, like every declaration: nothing is run.

A zod value is {"type", "nullable", "optional", "defaultValue"?, "description"?}.
"""

import re

from ...js import coalesce, trim
from ...model.naming import to_pascal_case, unique_name
from .lexer import Cursor
from .raw import MISSING, parse_literal, raw

_STRING_LIKE = {
    "string",
    "email",
    "url",
    "uuid",
    "cuid",
    "cuid2",
    "ulid",
    "ipv4",
    "ipv6",
    "base64",
    "emoji",
    "nanoid",
    "jwt",
    "templateLiteral",
}
_SCHEMA_SUFFIX = re.compile(r"Schema$")
_PARENTHESES = re.compile(r"^\(|\)$")


def _value(type_ref=None, nullable: bool = False, optional: bool = False) -> dict:
    return {"type": type_ref, "nullable": nullable, "optional": optional}


class ZodReader:
    def __init__(self, cursor: Cursor, source: str, declarations: dict, used_names: set[str]):
        self.cursor = cursor
        self.source = source
        self.declarations = declarations
        self.used_names = used_names
        # Schema constant → model name (UserSchema → User, from type User = z.infer<typeof UserSchema>)
        self.names: dict[str, str] = {}

    @staticmethod
    def uses(tokens: list) -> bool:
        """Whether the file uses Zod at all: z.object(, z.enum(…"""
        return any(
            token.value == "z"
            and index + 2 < len(tokens)
            and tokens[index + 1].value == "."
            and tokens[index + 2].kind == "ident"
            for index, token in enumerate(tokens)
        )

    def _model_name(self, constant: str) -> str:
        return self.names.get(constant) or _SCHEMA_SUFFIX.sub("", constant, count=1) or constant

    def run(self) -> None:
        tokens = self.cursor.tokens
        cursor = self.cursor

        def value_at(position: int):
            token = cursor.at(position)
            return token.value if token else None

        # Names first: type User = z.infer<typeof UserSchema> (also z.output / z.input)
        for index in range(len(tokens) - 8):
            if tokens[index].value != "type" or value_at(index + 2) != "=" or value_at(index + 3) != "z":
                continue
            if value_at(index + 5) not in ("infer", "output", "input", "TypeOf") or value_at(index + 7) != "typeof":
                continue
            self.names[tokens[index + 8].value] = tokens[index + 1].value
        index = 0
        while index < len(tokens) - 3:
            token = tokens[index]
            following = cursor.at(index + 1)
            if token.value not in ("const", "let", "var") or following.kind != "ident" or value_at(index + 2) != "=":
                index += 1
                continue
            start = value_at(index + 3)
            if start != "z" and start not in self.names and not _SCHEMA_SUFFIX.search(start or ""):
                index += 1
                continue
            constant = following.value
            cursor.index = index + 3
            name = self._model_name(constant)
            before = cursor.at(index - 1)
            doc = coalesce(token.doc, before.doc if before else None)
            self._declaration(name, constant, doc)
            index = max(index, cursor.index - 1) + 1

    def _declaration(self, name: str, constant: str, doc) -> None:
        cursor = self.cursor
        # z.object({ … }) (maybe extended) is a model; z.enum([…]) an enum; anything else an alias
        if cursor.is_("z") and cursor.is_(".", 1) and cursor.value(2) in ("object", "strictObject", "looseObject"):
            cursor.index += 3
            model = {"name": name, "kind": "type", "fields": self._object_fields(name), "framework": "zod"}
            if doc:
                model["description"] = doc
            self.used_names.add(name)
            self.declarations["models"].append(model)
            self._chain(_value(raw(name)), model)
            return
        if cursor.is_("z") and cursor.is_(".", 1) and cursor.is_("enum", 2) and cursor.is_("(", 3):
            cursor.index += 4
            values = self._enum_values()
            self.used_names.add(name)
            self.declarations["enums"].append(
                {"name": name, "kind": "literals", "values": [{"name": item} for item in values]}
            )
            return
        # An object built from another schema: BaseSchema.extend({ … })
        if cursor.is_ident() and cursor.is_(".", 1) and cursor.is_("extend", 2):
            parent = self._model_name(cursor.value())
            cursor.index += 3
            model = {"name": name, "kind": "type", "fields": [], "extends": [parent], "framework": "zod"}
            if cursor.eat("("):
                cursor.index -= 1
                model["fields"] = self._object_fields(name, True)
            self.used_names.add(name)
            self.declarations["models"].append(model)
            return
        value = self._read_value(name)
        if value["type"] and constant != name and "aliases" in self.declarations:
            self.declarations["aliases"][name] = value["type"]

    def _object_fields(self, owner: str, already_open: bool = False) -> list[dict]:
        """Fields of ({ key: schema, … }); the cursor is on (."""
        cursor = self.cursor
        fields: list[dict] = []
        if not already_open and not cursor.eat("("):
            return fields
        if already_open:
            cursor.eat("(")
        if not cursor.eat("{"):
            cursor.skip_until([")"])
            cursor.eat(")")
            return fields
        while not cursor.done and not cursor.is_("}"):
            if cursor.eat(","):
                continue
            if cursor.is_("..."):
                # ...BaseSchema.shape: the fields of another schema
                cursor.next()
                cursor.skip_until([",", "}"])
                continue
            key = cursor.peek()
            if not key or key.kind not in ("ident", "string") or not cursor.is_(":", 1):
                cursor.skip_until([",", "}"])
                continue
            cursor.index += 2
            value = self._read_value(f"{owner}{to_pascal_case(key.value)}")
            field = {
                "name": key.value,
                "type": value["type"],
                "optional": value["optional"],
                "nullable": value["nullable"],
            }
            if value.get("defaultValue", MISSING) is not MISSING:
                field["defaultValue"] = value["defaultValue"]
            description = coalesce(value.get("description"), key.doc)
            if description:
                field["description"] = description
            fields.append(field)
        cursor.eat("}")
        cursor.skip_until([")"])
        cursor.eat(")")
        return fields

    def _enum_values(self) -> list[str]:
        cursor = self.cursor
        values: list[str] = []
        cursor.eat("[")
        while not cursor.done and not cursor.is_("]") and not cursor.is_(")"):
            token = cursor.next()
            if token.kind == "string":
                values.append(token.value)
        cursor.eat("]")
        cursor.skip_until([")"])
        cursor.eat(")")
        return values

    def _arguments(self, hint: str) -> list[dict]:
        """The arguments of a call as zod values (z.union([a, b]), z.record(k, v))."""
        cursor = self.cursor
        values: list[dict] = []
        if not cursor.eat("("):
            return values
        is_list = cursor.eat("[")
        while not cursor.done and not cursor.is_(")") and not cursor.is_("]"):
            if cursor.eat(","):
                continue
            start = cursor.index
            values.append(self._read_value(hint))
            if cursor.index == start:
                cursor.next()
        if is_list:
            cursor.eat("]")
        cursor.skip_until([")"])
        cursor.eat(")")
        return values

    def _read_value(self, hint: str) -> dict:
        """A zod expression: a base (z.string(), another schema) and its chained methods."""
        cursor = self.cursor
        if cursor.is_("z") and cursor.is_(".", 1):
            cursor.index += 2
            # z.coerce.number(), z.iso.datetime(), z.string.email()…
            while cursor.is_ident() and cursor.is_(".", 1):
                cursor.index += 2
            method = cursor.next().value
            value = self._base(method, hint)
        elif cursor.is_ident():
            value = _value(raw(self._model_name(cursor.next().value)))
        elif cursor.peek() is not None and cursor.peek().kind in ("string", "number"):
            token = cursor.next()
            return _value(raw("string" if token.kind == "string" else "number"))
        else:
            cursor.skip_until([",", "}", ")"])
            return _value()
        return self._chain(value)

    def _plain(self, name: str) -> dict:
        self.cursor.skip_group()
        return _value(raw(name))

    def _base(self, method: str, hint: str) -> dict:
        cursor = self.cursor
        if method in ("number", "float32", "float64"):
            return self._plain("number")
        if method in ("int", "int32", "int64", "bigint"):
            return self._plain("integer")
        if method == "boolean":
            return self._plain("boolean")
        if method == "date":
            return self._plain("Date")
        if method in ("null", "undefined", "void"):
            return {**self._plain("null"), "nullable": True}
        if method in ("any", "unknown", "json"):
            return self._plain("unknown")
        if method in ("array", "set"):
            arguments = self._arguments(f"{hint}Item")
            items = arguments[0] if arguments else None
            args = [{**items["type"], "nullable": items["nullable"]}] if items and items["type"] else []
            return _value(raw("[]", args))
        if method in ("record", "map"):
            arguments = self._arguments(f"{hint}Value")
            value_type = (arguments[-1]["type"] if arguments else None) or raw("unknown")
            return _value(raw("{}", [raw("string"), value_type]))
        if method in ("object", "strictObject", "looseObject"):
            name = unique_name(to_pascal_case(hint) or "Inline", self.used_names)
            self.declarations["models"].append(
                {"name": name, "kind": "type", "fields": self._object_fields(name), "framework": "zod"}
            )
            return _value(raw(name))
        if method == "enum":
            cursor.eat("(")
            values = self._enum_values()
            name = unique_name(to_pascal_case(hint) or "Value", self.used_names)
            self.declarations["enums"].append(
                {"name": name, "kind": "literals", "values": [{"name": item} for item in values]}
            )
            return _value(raw(name))
        if method == "nativeEnum":
            arguments = self._arguments(hint)
            return arguments[0] if arguments else _value()
        if method == "literal":
            cursor.eat("(")
            token = cursor.next()
            cursor.skip_until([")"])
            cursor.eat(")")
            if token.kind == "number":
                name = "number"
            elif token.value in ("true", "false"):
                name = "boolean"
            else:
                name = "string"
            return _value(raw(name))
        if method in ("union", "discriminatedUnion"):
            options = [option for option in self._arguments(hint) if option["type"]]
            nullable = any(option["type"]["name"] == "null" for option in options)
            rest = [option for option in options if option["type"]["name"] != "null"]
            if len(rest) == 1:
                return {**rest[0], "nullable": rest[0]["nullable"] or nullable}
            return _value(raw("unknown"), nullable)
        if method in ("nullable", "optional", "nullish", "lazy"):
            # z.nullable(X), z.optional(X), z.lazy(() => X)
            cursor.eat("(")
            if cursor.is_("("):
                cursor.skip_group()
            cursor.eat("=>")
            inner = self._read_value(hint)
            cursor.skip_until([")"])
            cursor.eat(")")
            if method == "nullable":
                return {**inner, "nullable": True}
            if method == "optional":
                return {**inner, "optional": True}
            if method == "nullish":
                return {**inner, "nullable": True, "optional": True}
            return inner
        # Text with a format (z.email(), z.uuid(), z.iso.datetime()): at run time it is a string
        text = method in _STRING_LIKE or method in ("datetime", "time", "duration")
        return self._plain("string" if text else "unknown")

    def _chain(self, value: dict, model: dict | None = None) -> dict:
        """Chained methods: .int(), .nullable(), .optional(), .default(v), .array(), .describe(…)."""
        cursor = self.cursor
        result = value
        while cursor.is_(".") and cursor.is_ident(1):
            cursor.next()
            method = cursor.next().value
            args_start = cursor.index
            if method == "extend" and model is not None:
                model["fields"].extend(self._object_fields(model["name"]))
                continue
            if cursor.is_("("):
                cursor.skip_group()
            args = trim(_PARENTHESES.sub("", cursor.text_between(self.source, args_start, cursor.index)))
            if method == "int":
                if result["type"] and result["type"]["name"] == "number":
                    result = {**result, "type": raw("integer")}
            elif method == "nullable":
                result = {**result, "nullable": True}
            elif method == "optional":
                result = {**result, "optional": True}
            elif method == "nullish":
                result = {**result, "nullable": True, "optional": True}
            elif method == "array":
                result = _value(raw("[]", [result["type"]] if result["type"] else []))
            elif method in ("default", "catch"):
                literal = parse_literal(args)
                result = {**result, "optional": True}
                if literal is not MISSING:
                    result["defaultValue"] = literal
            elif method == "describe":
                literal = parse_literal(args)
                if isinstance(literal, str):
                    result = {**result, "description": literal}
            # Checks and refinements (min, max, email, regex, refine, transform…) do not change the shape
        return result
