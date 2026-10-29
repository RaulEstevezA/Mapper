"""Dart extension methods. Mirrors web/src/core/generate/languages/dart.ts."""

import json
import re

from ...js import js_string
from ...model.naming import to_camel_case, to_snake_case
from ...model.schema import find_enum
from ..emitter import Emitter, indent, make_expression_syntax, make_syntax, roots
from ..naming import NamingRules, field_name, is_valid_identifier, type_name
from ..types import CodeGenerator, GeneratorOption, option_value

RESERVED = frozenset(
    "abstract as assert async await break case catch class const continue default do dynamic else enum export "
    "extends external factory false final finally for get if implements import in is library new null operator part "
    "rethrow return set static super switch this throw true try var void while with yield".split()
)

NAMING = NamingRules("dart", "camelCase", RESERVED, lambda name: f"{name}_")


def _is_primitive(type_ref: dict, *names: str) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in names


def _is_number(type_ref: dict) -> bool:
    return _is_primitive(type_ref, "integer", "float", "decimal")


_SPECIAL = re.compile(r"[\\'$]")
_SIMPLE = re.compile(r"^[\w.()'!?]+$")


def _escape(text: str) -> str:
    return _SPECIAL.sub(lambda match: f"\\{match.group(0)}", text)


def single(text: str) -> str:
    return "'" + _escape(text).replace("\n", "\\n") + "'"


def operand(code: str) -> str:
    return code if _SIMPLE.match(code) and " " not in code else f"({code})"


def _placeholder(name: str) -> str:
    message = single(f"No value for {name} in the mapping")
    return f"throw UnimplementedError({message})"


class _Writer:
    def __init__(self, plan: dict, settings: dict):
        self.plan = plan
        self.settings = settings
        self.helpers: dict[str, tuple[str, str]] = {}
        self.uses_math = False
        self.emitter = Emitter(self._syntax(), lambda field, _owner, side: self.name(field, side))

    def name(self, field: dict, side: str) -> str:
        schema = self.plan["source"] if side == "source" else self.plan["target"]
        return field_name(field, schema, NAMING, self.settings["naming"])

    def enum_member(self, enum_def: dict, name: str, side: str) -> str:
        schema = self.plan["source"] if side == "source" else self.plan["target"]
        is_dart = (schema.get("origin") or {}).get("language") == "dart"
        member = name if is_dart and is_valid_identifier(name) else to_camel_case(name) or "value"
        return f"{type_name(enum_def['name'])}.{f'{member}_' if member in RESERVED else member}"

    def function_name(self, mapper: dict) -> str:
        return f"to{type_name(mapper['target']['name'])}"

    def literal(self, value, type_ref: dict) -> str:
        if value is None:
            return "null"
        if type_ref["kind"] == "enum" and isinstance(value, str):
            enum_def = find_enum(self.plan["target"], type_ref["name"])
            if enum_def:
                return self.enum_member(enum_def, value, "target")
        if isinstance(value, bool):
            return js_string(value)
        if isinstance(value, (int, float)):
            if _is_primitive(type_ref, "float", "decimal") and float(value).is_integer():
                return f"{js_string(value)}.0"
            return js_string(value)
        if _is_primitive(type_ref, "datetime", "date"):
            return f"DateTime.parse({single(value)})"
        return single(value)

    def convert(self, expr: str, origin: dict, to: dict) -> str:
        target = operand(expr)
        if _is_number(origin) and _is_number(to):
            if _is_primitive(to, "integer") and not _is_primitive(origin, "integer"):
                return f"{target}.toInt()"
            if not _is_primitive(to, "integer") and _is_primitive(origin, "integer"):
                return f"{target}.toDouble()"
            return expr
        if _is_primitive(to, "string"):
            if _is_primitive(origin, "string", "uuid"):
                return expr
            if origin["kind"] == "enum":
                return f"{target}.name"
            if _is_primitive(origin, "datetime", "date"):
                return f"{target}.toIso8601String()"
            return f"{target}.toString()"
        if _is_primitive(origin, "string", "any"):
            text = f"{target}.toString()" if _is_primitive(origin, "any") else expr
            if _is_primitive(to, "integer"):
                return f"int.parse({text})"
            if _is_primitive(to, "float", "decimal"):
                return f"double.parse({text})"
            if _is_primitive(to, "datetime", "date"):
                return f"DateTime.parse({text})"
            if to["kind"] == "enum":
                return f"{type_name(to['name'])}.values.byName({text})"
        if _is_primitive(origin, "boolean") and _is_primitive(to, "integer"):
            return f"{expr} ? 1 : 0"
        return expr

    def _enum_helper(self, node: dict) -> str:
        source = node.get("source")
        target = type_name(node["target"]["name"])
        base = f"_to{target}"
        key = json.dumps([node["pairs"], node.get("fallback"), source["name"] if source else None])
        name = base
        n = 2
        while name in self.helpers and self.helpers[name][0] != key:
            name = f"{base}{n}"
            n += 1
        if name not in self.helpers:
            arms = [
                f"{self.enum_member(source, pair['from'], 'source') if source else single(pair['from'])}"
                f" => {self.enum_member(node['target'], pair['to'], 'target')},"
                for pair in node["pairs"]
            ]
            complete = source is not None and len(node["pairs"]) >= len(source["values"])
            if "fallback" in node:
                arms.append(f"_ => {self.enum_member(node['target'], node['fallback'], 'target')},")
            elif not complete:
                described = source["name"] if source else "value"
                arms.append(f"_ => throw ArgumentError.value(value, 'value', {single(f'Unexpected {described}')}),")
            parameter = type_name(source["name"]) if source else "String"
            body = indent("\n".join(arms), 6)
            code = f"{target} {name}({parameter} value) => switch (value) {{\n{body}\n    }};"
            self.helpers[name] = (key, code)
        return name

    def _split(self, expr: str, separator: str, part) -> str:
        split = f"{operand(expr)}.split({single(separator)})"
        if part == 0:
            return f"{split}.first"
        if part == "last":
            return f"{split}.last"
        if part == "rest":
            return f"{split}.skip(1).join({single(separator)})"
        return f"{split}.elementAtOrNull({part}) ?? ''"

    def _boolean(self, expr: str, true_values: list, origin: dict) -> str:
        enum_def = find_enum(self.plan["source"], origin["name"]) if origin["kind"] == "enum" else None
        values = [self.enum_member(enum_def, value, "source") if enum_def else single(value) for value in true_values]
        return f"{expr} == {values[0]}" if len(values) == 1 else f"{{{', '.join(values)}}}.contains({expr})"

    def _epoch(self, expr: str, unit: str, to_date: bool, origin: dict, _to: dict) -> str:
        if to_date:
            millis = f"{operand(expr)} * 1000" if unit == "seconds" else expr
            value = f"({millis}).round()" if _is_primitive(origin, "float") else millis
            return f"DateTime.fromMillisecondsSinceEpoch({value}, isUtc: true)"
        if unit == "seconds":
            return f"{operand(expr)}.millisecondsSinceEpoch ~/ 1000"
        return f"{operand(expr)}.millisecondsSinceEpoch"

    def _arithmetic(self, expr: str, operator: str, value, type_ref: dict) -> str:
        if operator == "/" and _is_primitive(type_ref, "integer"):
            return f"{operand(expr)} ~/ {js_string(value)}"
        return f"{operand(expr)} {operator} {js_string(value)}"

    def _list(self, expr: str, item: str, element: str, is_map: bool, element_is_item: bool, container) -> str:
        is_set = (container or "").endswith("Set")
        if is_map:
            return (
                f"Map.of({expr})"
                if element_is_item
                else f"{operand(expr)}.map((key, {item}) => MapEntry(key, {element}))"
            )
        if element_is_item:
            return f"Set.of({expr})" if is_set else f"List.of({expr})"
        return f"{operand(expr)}.map(({item}) => {element}).{'toSet()' if is_set else 'toList()'}"

    def _null_safe(self, expr: str, build, _context: dict) -> str:
        marker = "\u0000"
        built = build(marker)
        if built.startswith(f"{marker}.") and marker not in built[1:]:
            return f"{operand(expr)}?{built[1:]}"
        # Fields cannot be promoted to non-null: the value is asserted inside the check
        return f"{operand(expr)} == null ? null : {build(f'{operand(expr)}!')}"

    def _call(self, name: str, args: list[str], types: list[dict | None]) -> str:
        a = args[0] if args else None
        b = args[1] if len(args) > 1 else None
        c = args[2] if len(args) > 2 else None
        if name == "upper":
            return f"{operand(a)}.toUpperCase()"
        if name == "lower":
            return f"{operand(a)}.toLowerCase()"
        if name == "trim":
            return f"{operand(a)}.trim()"
        if name == "length":
            return f"{operand(a)}.length"
        if name == "concat":
            return "'" + "".join(f"${{{arg}}}" for arg in args) + "'"
        if name == "substring":
            return (
                f"{operand(a)}.substring({b})"
                if c is None
                else f"{operand(a)}.substring({b}, {operand(b)} + {operand(c)})"
            )
        if name == "replace":
            return f"{operand(a)}.replaceAll({b}, {c})"
        if name in ("round", "floor", "ceil"):
            # The ToDouble forms keep a double, like the expression's numbers
            return f"{operand(a)}.{name}ToDouble()"
        if name == "abs":
            return f"{operand(a)}.abs()"
        if name in ("min", "max"):
            self.uses_math = True
            return f"{name}({a}, {b})"
        if name == "toString":
            return f"{operand(a)}.toString()"
        return f"double.parse({a})"

    def _syntax(self):
        def concat(parts: list[str], separator: str) -> str:
            return "'" + _escape(separator).join(f"${{{part}}}" for part in parts) + "'"

        return make_syntax(
            access=lambda base, _step, name: name if base == "this" else f"{base}.{name}",
            safe_access=lambda base, _step, name: f"{base}?.{name}",
            literal=self.literal,
            convert=self.convert,
            concat=concat,
            split=self._split,
            boolean=self._boolean,
            enum_map=lambda expr, node, _origin: f"{self._enum_helper(node)}({expr})",
            epoch=self._epoch,
            arithmetic=self._arithmetic,
            mapper_call=lambda mapper, expr: (
                f"{self.function_name(mapper)}()"
                if expr == "this"
                else f"{operand(expr)}.{self.function_name(mapper)}()"
            ),
            list=self._list,
            coalesce=lambda expr, fallback, _type: f"{expr} ?? {fallback}",
            null_safe=self._null_safe,
            unwrap=lambda expr, _type: f"{operand(expr)}!",
            placeholder=lambda _type, field: _placeholder(field["name"]),
            expression=make_expression_syntax(
                binary=lambda operator, left, right: f"{left} {operator} {right}",
                not_=lambda value: f"!{operand(value)}",
                conditional=lambda condition, then, otherwise, _type: f"{condition} ? {then} : {otherwise}",
                call=self._call,
            ),
        )

    def extension(self, mapper: dict) -> str:
        context = roots("this")
        target = type_name(mapper["target"]["name"])
        named = mapper["target"].get("construction") != "positional"
        lines: list[str] = []
        for assignment in mapper["assignments"]:
            code = self.emitter.assignment(assignment, context)
            if code is None:
                # Positional arguments cannot be skipped
                if not named:
                    lines.append("null,")
                continue
            lines.append(f"{self.name(assignment['field'], 'target')}: {code}," if named else f"{code},")
        body = f"{target}(\n{indent(chr(10).join(lines), 8)}\n      )" if lines else f"{target}()"
        source = type_name(mapper["source"]["name"])
        return f"extension {source}Mapping on {source} {{\n  {target} {self.function_name(mapper)}() => {body};\n}}"


def _generate(plan: dict, settings: dict) -> dict:
    writer = _Writer(plan, settings)
    extensions = [writer.extension(mapper) for mapper in plan["mappers"]]
    helpers = [code for _, code in writer.helpers.values()]
    module = option_value(dart_generator, plan, settings, "modelsImport")
    imports = "\n\n".join(
        line
        for line in ["import 'dart:math';" if writer.uses_math else "", f"import {single(module)};" if module else ""]
        if line
    )
    code = "\n\n".join(part for part in [imports, *extensions, *helpers] if part != "") + "\n"
    name = f"{to_snake_case(plan['root']['source']['name'])}_mapping.dart"
    return {"files": [{"name": name, "code": code}], "notes": writer.emitter.notes}


dart_generator = CodeGenerator(
    "dart",
    "Dart",
    "dart",
    ("extensions",),
    (GeneratorOption("modelsImport", ("models.dart",), "text"),),
    _generate,
)
