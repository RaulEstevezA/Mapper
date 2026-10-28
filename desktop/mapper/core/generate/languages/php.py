"""PHP static mappers, for objects or arrays. Mirrors web/src/core/generate/languages/php.ts."""

import json
import re

from ...js import js_string
from ...model.naming import to_pascal_case
from ...model.schema import find_enum
from ..emitter import Emitter, indent, make_expression_syntax, make_syntax, roots
from ..naming import NamingRules, field_name, is_valid_identifier, type_name
from ..plan import is_document_schema, plan_for_plain_objects
from ..types import CodeGenerator, GeneratorOption, option_value

NAMING = NamingRules("php", "camelCase", frozenset(), lambda name: name)


def _is_primitive(type_ref: dict, *names: str) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in names


def _is_number(type_ref: dict) -> bool:
    return _is_primitive(type_ref, "integer", "float", "decimal")


def single(text: str) -> str:
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"


_SIMPLE = re.compile(r"^[\w$>\[\]'()-]+$")
_CALL = re.compile(r"^self::(\w+)\((\$\w+)\)$")


def operand(code: str) -> str:
    return code if _SIMPLE.match(code) and " " not in code else f"({code})"


def _capitalize(name: str) -> str:
    return name[:1].upper() + name[1:]


def _placeholder(name: str) -> str:
    message = single(f"No value for {name} in the mapping")
    return f"throw new \\LogicException({message})"


class _Writer:
    def __init__(self, plan: dict, settings: dict, source_array: bool, target_array: bool):
        self.plan = plan
        self.settings = settings
        self.source_array = source_array
        self.target_array = target_array
        self.helpers: dict[str, tuple[str, str]] = {}
        self.emitter = Emitter(self._syntax(), lambda field, _owner, side: self.name(field, side))

    def name(self, field: dict, side: str) -> str:
        if self.source_array if side == "source" else self.target_array:
            return field["name"]
        schema = self.plan["source"] if side == "source" else self.plan["target"]
        return field_name(field, schema, NAMING, self.settings["naming"])

    def enum_case(self, enum_def: dict, name: str, side: str) -> str:
        as_array = self.source_array if side == "source" else self.target_array
        value = next((item for item in enum_def["values"] if item["name"] == name), None)
        if as_array or enum_def.get("kind") == "literals":
            wire = value.get("value") if value else None
            if isinstance(wire, (int, float)) and not isinstance(wire, bool):
                return js_string(wire)
            return single(js_string(wire if wire is not None else name))
        return (
            f"{type_name(enum_def['name'])}::{name if is_valid_identifier(name) else to_pascal_case(name) or 'Value'}"
        )

    def method_name(self, mapper: dict) -> str:
        return f"to{type_name(mapper['target']['name'])}"

    def literal(self, value, type_ref: dict) -> str:
        if value is None:
            return "null"
        if type_ref["kind"] == "enum" and isinstance(value, str):
            enum_def = find_enum(self.plan["target"], type_ref["name"])
            if enum_def:
                return self.enum_case(enum_def, value, "target")
        if isinstance(value, bool):
            return js_string(value)
        if isinstance(value, (int, float)):
            if _is_primitive(type_ref, "float", "decimal") and float(value).is_integer():
                return f"{js_string(value)}.0"
            return js_string(value)
        if _is_primitive(type_ref, "datetime", "date") and not self.target_array:
            return f"new \\DateTimeImmutable({single(value)})"
        return single(value)

    def convert(self, expr: str, origin: dict, to: dict) -> str:
        if _is_number(origin) and _is_number(to):
            if _is_primitive(to, "integer") and not _is_primitive(origin, "integer"):
                return f"(int) {operand(expr)}"
            if _is_primitive(to, "float", "decimal") and _is_primitive(origin, "integer"):
                return f"(float) {operand(expr)}"
            return expr
        if _is_primitive(to, "string"):
            if _is_primitive(origin, "string", "uuid"):
                return expr
            if origin["kind"] == "enum":
                enum_def = find_enum(self.plan["source"], origin["name"])
                literals = bool(enum_def) and enum_def.get("kind") == "literals"
                return expr if self.source_array or literals else f"{operand(expr)}->value"
            if _is_primitive(origin, "datetime"):
                return f"{operand(expr)}->format(\\DATE_ATOM)"
            if _is_primitive(origin, "date"):
                return f"{operand(expr)}->format('Y-m-d')"
            return f"(string) {operand(expr)}"
        if _is_primitive(origin, "string", "any"):
            if _is_primitive(to, "integer"):
                return f"(int) {operand(expr)}"
            if _is_primitive(to, "float", "decimal"):
                return f"(float) {operand(expr)}"
            if _is_primitive(to, "datetime", "date"):
                return f"new \\DateTimeImmutable({expr})"
            if to["kind"] == "enum":
                enum_def = find_enum(self.plan["target"], to["name"])
                literals = bool(enum_def) and enum_def.get("kind") == "literals"
                return expr if self.target_array or literals else f"{type_name(to['name'])}::from({expr})"
        if _is_primitive(origin, "boolean") and _is_primitive(to, "integer"):
            return f"(int) {operand(expr)}"
        return expr

    def _enum_helper(self, node: dict) -> str:
        source = node.get("source")
        target = "string" if self.target_array else type_name(node["target"]["name"])
        base = f"to{type_name(node['target']['name'])}"
        key = json.dumps([node["pairs"], node.get("fallback"), source["name"] if source else None])
        name = base
        n = 2
        while name in self.helpers and self.helpers[name][0] != key:
            name = f"{base}{n}"
            n += 1
        if name not in self.helpers:
            arms = []
            for pair in node["pairs"]:
                origin = self.enum_case(source, pair["from"], "source") if source else single(pair["from"])
                arms.append(f"{origin} => {self.enum_case(node['target'], pair['to'], 'target')},")
            if "fallback" in node:
                arms.append(f"default => {self.enum_case(node['target'], node['fallback'], 'target')},")
            else:
                message = single(f"Unexpected {source['name'] if source else 'value'}")
                arms.append(f"default => throw new \\UnexpectedValueException({message}),")
            parameter = type_name(source["name"]) if source and not self.source_array else "string"
            body = indent("\n".join(arms), 12)
            code = (
                f"    private static function {name}({parameter} $value): {target}\n    {{\n"
                f"        return match ($value) {{\n{body}\n        }};\n    }}"
            )
            self.helpers[name] = (key, code)
        return name

    def _read(self, owner: dict, name: str) -> str:
        return f"get{_capitalize(name)}()" if (owner.get("metadata") or {}).get("accessors") == "getters" else name

    def _access(self, base: str, step: dict, name: str) -> str:
        if self.source_array:
            return f"{base}[{single(name)}]{' ?? null' if step['nullable'] else ''}"
        return f"{base}->{self._read(step['owner'], name)}"

    def _safe_access(self, base: str, step: dict, name: str) -> str:
        if self.source_array:
            return f"({base})[{single(name)}] ?? null"
        return f"{base}?->{self._read(step['owner'], name)}"

    def _split(self, expr: str, separator: str, part) -> str:
        sep = single(separator)
        if part == 0:
            return f"explode({sep}, {expr})[0]"
        if part == "last":
            return f"array_slice(explode({sep}, {expr}), -1)[0]"
        if part == "rest":
            return f"explode({sep}, {expr}, 2)[1] ?? ''"
        return f"explode({sep}, {expr})[{part}] ?? ''"

    def _boolean(self, expr: str, true_values: list, origin: dict) -> str:
        enum_def = find_enum(self.plan["source"], origin["name"]) if origin["kind"] == "enum" else None
        values = [self.enum_case(enum_def, value, "source") if enum_def else single(value) for value in true_values]
        if len(values) == 1:
            return f"{operand(expr)} === {values[0]}"
        return f"in_array({expr}, [{', '.join(values)}], true)"

    def _epoch(self, expr: str, unit: str, to_date: bool, _origin: dict, _to: dict) -> str:
        if to_date:
            seconds = operand(expr) if unit == "seconds" else f"({expr} / 1000)"
            return f"(new \\DateTimeImmutable())->setTimestamp((int) {seconds})"
        return f"{operand(expr)}->getTimestamp()" if unit == "seconds" else f"(int) {operand(expr)}->format('Uv')"

    def _list(self, expr: str, item: str, element: str, _is_map: bool, element_is_item: bool, _container) -> str:
        if element_is_item:
            return expr
        # array_map keeps the keys, so it maps lists and dictionaries alike
        call = _CALL.match(element)
        if call and call.group(2) == item:
            return f"array_map(self::{call.group(1)}(...), {expr})"
        return f"array_map(fn ({item}) => {element}, {expr})"

    def _binary(self, operator: str, left: str, right: str) -> str:
        if operator == "==":
            written = "==="
        elif operator == "!=":
            written = "!=="
        elif operator == "+" and (left + right).startswith("'"):
            written = "."
        else:
            written = operator
        return f"{left} {written} {right}"

    def _call(self, name: str, args: list[str]) -> str:
        a = args[0] if args else None
        b = args[1] if len(args) > 1 else None
        c = args[2] if len(args) > 2 else None
        if name == "upper":
            return f"mb_strtoupper({a})"
        if name == "lower":
            return f"mb_strtolower({a})"
        if name == "trim":
            return f"trim({a})"
        if name == "length":
            return f"mb_strlen({a})"
        if name == "concat":
            return " . ".join(f"(string) {operand(arg)}" for arg in args)
        if name == "substring":
            return f"mb_substr({a}, {b})" if c is None else f"mb_substr({a}, {b}, {c})"
        if name == "replace":
            return f"str_replace({b}, {c}, {a})"
        if name in ("round", "floor", "ceil", "abs", "min", "max"):
            return f"{name}({', '.join(args)})"
        if name == "toString":
            return f"(string) {operand(a)}"
        return f"(float) {operand(a)}"

    def _syntax(self):
        return make_syntax(
            access=self._access,
            safe_access=self._safe_access,
            literal=self.literal,
            convert=self.convert,
            concat=lambda parts, separator: f" . {single(separator)} . ".join(operand(part) for part in parts),
            split=self._split,
            boolean=self._boolean,
            enum_map=lambda expr, node, _origin: f"self::{self._enum_helper(node)}({expr})",
            epoch=self._epoch,
            arithmetic=lambda expr, operator, value, _type: f"{operand(expr)} {operator} {js_string(value)}",
            mapper_call=lambda mapper, expr: f"self::{self.method_name(mapper)}({expr})",
            list=self._list,
            coalesce=lambda expr, fallback, _type: f"{expr} ?? {fallback}",
            null_safe=lambda expr, build, _context: f"{operand(expr)} === null ? null : {build(expr)}",
            variable_prefix="$",
            unwrap=lambda expr, _type: (
                f"{expr} ?? throw new \\InvalidArgumentException('A required value is missing in the source.')"
            ),
            placeholder=lambda _type, field: _placeholder(field["name"]),
            expression=make_expression_syntax(
                binary=self._binary,
                not_=lambda value: f"!{operand(value)}",
                conditional=lambda condition, then, otherwise: f"{condition} ? {then} : {otherwise}",
                call=self._call,
            ),
        )

    def method(self, mapper: dict) -> str:
        context = roots("$source")
        values = [(assignment, self.emitter.assignment(assignment, context)) for assignment in mapper["assignments"]]
        present = [(assignment, code) for assignment, code in values if code is not None]
        source_type = "array" if self.source_array else type_name(mapper["source"]["name"])
        target_type = "array" if self.target_array else type_name(mapper["target"]["name"])
        if self.target_array:
            lines = [f"{single(self.name(assignment['field'], 'target'))} => {code}," for assignment, code in present]
            body = f"return [\n{indent(chr(10).join(lines), 4)}\n];"
        elif mapper["target"].get("construction") in ("named", "positional"):
            lines = [f"{self.name(assignment['field'], 'target')}: {code}," for assignment, code in present]
            body = f"return new {target_type}(\n{indent(chr(10).join(lines), 4)}\n);"
        else:
            setters = (mapper["target"].get("metadata") or {}).get("accessors") == "getters"
            lines = []
            for assignment, code in present:
                name = self.name(assignment["field"], "target")
                lines.append(f"$target->set{_capitalize(name)}({code});" if setters else f"$target->{name} = {code};")
            body = "\n".join([f"$target = new {target_type}();", *lines, "return $target;"])
        return (
            f"    public static function {self.method_name(mapper)}({source_type} $source): {target_type}\n"
            f"    {{\n{indent(body, 8)}\n    }}"
        )

    def uses(self) -> list[str]:
        uses: set[str] = set()

        def add(schema: dict, item: dict, as_array: bool) -> None:
            if not as_array and (schema.get("origin") or {}).get("language") == "php" and item.get("namespace"):
                uses.add(f"{item['namespace']}\\{type_name(item['name'])}")

        for mapper in self.plan["mappers"]:
            add(self.plan["source"], mapper["source"], self.source_array)
            add(self.plan["target"], mapper["target"], self.target_array)
        for enum_def in self.plan["enums"]["source"]:
            add(self.plan["source"], enum_def, self.source_array)
        for enum_def in self.plan["enums"]["target"]:
            add(self.plan["target"], enum_def, self.target_array)
        return sorted(uses)


def _generate(original: dict, settings: dict) -> dict:
    source_array = option_value(php_generator, original, settings, "sourceAccess") == "array"
    target_array = option_value(php_generator, original, settings, "targetStyle") == "array"
    plan = plan_for_plain_objects(original, source_array, target_array)
    writer = _Writer(plan, settings, source_array, target_array)
    methods = [writer.method(mapper) for mapper in plan["mappers"]]
    helpers = [code for _, code in writer.helpers.values()]
    namespace = option_value(php_generator, plan, settings, "namespace")
    name = f"{type_name(plan['root']['source']['name'])}Mapper"
    uses = [item for item in writer.uses() if not namespace or item[: item.rfind("\\")] != namespace]
    parts = [
        "<?php",
        "declare(strict_types=1);",
        f"namespace {namespace};" if namespace else "",
        "\n".join(f"use {item};" for item in uses),
    ]
    header = "\n\n".join(part for part in parts if part != "")
    members = "\n\n".join([*methods, *helpers])
    code = f"{header}\n\nfinal class {name}\n{{\n{members}\n}}\n"
    return {"files": [{"name": f"{name}.php", "code": code}], "notes": writer.emitter.notes}


def _defaults(plan: dict) -> dict:
    defaults = {
        "sourceAccess": "array" if is_document_schema(plan["source"]) else "object",
        "targetStyle": "array" if is_document_schema(plan["target"]) else "object",
    }
    namespace = plan["root"]["target"].get("namespace")
    if (plan["target"].get("origin") or {}).get("language") == "php" and namespace:
        defaults["namespace"] = namespace
    return defaults


php_generator = CodeGenerator(
    "php",
    "PHP",
    "php",
    ("static",),
    (
        GeneratorOption("sourceAccess", ("object", "array")),
        GeneratorOption("targetStyle", ("object", "array")),
        GeneratorOption("namespace", ("",), "text"),
    ),
    _generate,
    _defaults,
)
