"""Kotlin extension functions. Mirrors web/src/core/generate/languages/kotlin.ts."""

import json
import re

from ...js import js_string
from ...model.naming import to_screaming_snake_case
from ...model.schema import find_enum
from ..emitter import Emitter, indent, make_expression_syntax, make_syntax, quote, roots
from ..naming import NamingRules, field_name, is_valid_identifier, type_name
from ..types import CodeGenerator, GeneratorOption, option_value

RESERVED = frozenset(
    "as break class continue do else false for fun if in interface is null object package return super this throw "
    "true try typealias typeof val var when while".split()
)

NAMING = NamingRules("kotlin", "camelCase", RESERVED, lambda name: f"`{name}`")


def _is_number(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("integer", "float", "decimal")


def _is_primitive(type_ref: dict, *names: str) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in names


_SIMPLE = re.compile(r'^[\w.()"?!]+$')
_TEMPLATE_SPECIAL = re.compile(r'[\\"$]')


def operand(code: str) -> str:
    return code if _SIMPLE.match(code) and " " not in code else f"({code})"


def _escape(text: str) -> str:
    return _TEMPLATE_SPECIAL.sub(lambda match: f"\\{match.group(0)}", text)


def _template(parts: list[str], separator: str) -> str:
    """Kotlin string template: $ and " escaped, values in ${…}."""
    return '"' + _escape(separator).join(f"${{{part}}}" for part in parts) + '"'


_DATE_TIME_CLASSES = ("Instant", "OffsetDateTime", "LocalDateTime", "ZonedDateTime")


def _date_time_class(schema: dict) -> str:
    if (schema.get("origin") or {}).get("language") in ("kotlin", "java"):
        for model in schema["models"]:
            for field in model["fields"]:
                original = field.get("originalType")
                declared = re.sub(r"^.*\.", "", re.sub(r"\?$", "", original)) if original else None
                if _is_primitive(field["type"], "datetime") and declared and declared in _DATE_TIME_CLASSES:
                    return declared
    return "Instant"


def _integral(value) -> bool:
    return float(value).is_integer()


_LOWER = re.compile(r"[a-z]")
_TRAILING_COMMA = re.compile(r",$")


class _Writer:
    def __init__(self, plan: dict, settings: dict):
        self.plan = plan
        self.settings = settings
        self.imports: dict[str, None] = {}
        self.helpers: dict[str, tuple[str, str]] = {}
        self.source_date_time = _date_time_class(plan["source"])
        self.target_date_time = _date_time_class(plan["target"])
        self.emitter = Emitter(self._syntax(), lambda field, _owner, side: self.name(field, side))

    def name(self, field: dict, side: str) -> str:
        schema = self.plan["source"] if side == "source" else self.plan["target"]
        return field_name(field, schema, NAMING, self.settings["naming"])

    def enum_member(self, enum_def: dict, name: str) -> str:
        keep = is_valid_identifier(name) and not (enum_def.get("kind") == "literals" and _LOWER.search(name))
        return f"{type_name(enum_def['name'])}.{name if keep else to_screaming_snake_case(name) or 'VALUE'}"

    def function_name(self, mapper: dict) -> str:
        return f"to{type_name(mapper['target']['name'])}"

    def use(self, name: str) -> None:
        self.imports[name] = None

    def literal(self, value, type_ref: dict) -> str:
        if value is None:
            return "null"
        if type_ref["kind"] == "enum" and isinstance(value, str):
            enum_def = find_enum(self.plan["target"], type_ref["name"])
            if enum_def:
                return self.enum_member(enum_def, value)
        if isinstance(value, bool):
            return js_string(value)
        if isinstance(value, (int, float)):
            if _is_primitive(type_ref, "decimal"):
                self.use("java.math.BigDecimal")
                return f"BigDecimal({quote(js_string(value))})"
            if _is_primitive(type_ref, "float"):
                return f"{js_string(value)}.0" if _integral(value) else js_string(value)
            if _is_primitive(type_ref, "integer") and type_ref.get("bits") != 32:
                return f"{js_string(value)}L"
            return js_string(value)
        if _is_primitive(type_ref, "datetime"):
            self.use(f"java.time.{self.target_date_time}")
            return f"{self.target_date_time}.parse({quote(value)})"
        return f'"{_escape(value)}"'

    def convert(self, expr: str, origin: dict, to: dict) -> str:
        target = operand(expr)
        if _is_number(origin) and _is_number(to):
            if to["name"] == "decimal":
                if origin["name"] == "decimal":
                    return expr
                self.use("java.math.BigDecimal")
                return f"{target}.toBigDecimal()"
            if to["name"] == "float":
                return (
                    expr
                    if origin["name"] == "float" and origin.get("bits") == to.get("bits")
                    else f"{target}.toDouble()"
                )
            if origin["name"] != "integer":
                return f"{target}.toInt()" if to.get("bits") == 32 else f"{target}.toLong()"
            if to.get("bits") == 32 and origin.get("bits") != 32:
                return f"{target}.toInt()"
            if to.get("bits") != 32 and origin.get("bits") == 32:
                return f"{target}.toLong()"
            return expr
        if _is_primitive(to, "string"):
            if _is_primitive(origin, "string"):
                return expr
            if origin["kind"] == "enum":
                return f"{target}.name"
            return f"{target}.toString()"
        if _is_primitive(origin, "string", "any"):
            text = f"{target}.toString()" if _is_primitive(origin, "any") else target
            if to["kind"] == "primitive":
                name = to["name"]
                if name == "integer":
                    return f"{text}.toInt()" if to.get("bits") == 32 else f"{text}.toLong()"
                if name == "float":
                    return f"{text}.toDouble()"
                if name == "decimal":
                    self.use("java.math.BigDecimal")
                    return f"{text}.toBigDecimal()"
                if name == "datetime":
                    self.use(f"java.time.{self.target_date_time}")
                    return f"{self.target_date_time}.parse({text})"
                parsers = {"date": "LocalDate", "time": "LocalTime", "duration": "Duration"}
                if name in parsers:
                    self.use(f"java.time.{parsers[name]}")
                    return f"{parsers[name]}.parse({text})"
                if name == "uuid":
                    self.use("java.util.UUID")
                    return f"UUID.fromString({text})"
            if to["kind"] == "enum":
                return f"{type_name(to['name'])}.valueOf({text})"
        if _is_primitive(origin, "date") and _is_primitive(to, "datetime"):
            self.use("java.time.ZoneOffset")
            if self.target_date_time == "LocalDateTime":
                return f"{target}.atStartOfDay()"
            if self.target_date_time == "Instant":
                return f"{target}.atStartOfDay().toInstant(ZoneOffset.UTC)"
            return f"{target}.atStartOfDay().atOffset(ZoneOffset.UTC)"
        if _is_primitive(origin, "datetime") and _is_primitive(to, "date"):
            if self.source_date_time == "Instant":
                self.use("java.time.ZoneOffset")
                return f"{target}.atOffset(ZoneOffset.UTC).toLocalDate()"
            return f"{target}.toLocalDate()"
        if _is_primitive(origin, "boolean") and _is_primitive(to, "integer"):
            return f"if ({expr}) 1 else 0"
        return expr

    def _enum_helper(self, node: dict) -> str:
        source = node.get("source")
        target = type_name(node["target"]["name"])
        base = f"to{target}"
        key = json.dumps([node["pairs"], node.get("fallback"), source["name"] if source else None])
        name = base
        n = 2
        while name in self.helpers and self.helpers[name][0] != key:
            name = f"{base}{n}"
            n += 1
        if name not in self.helpers:
            branches = [
                f"{self.enum_member(source, pair['from']) if source else quote(pair['from'])}"
                f" -> {self.enum_member(node['target'], pair['to'])}"
                for pair in node["pairs"]
            ]
            complete = source is not None and len(node["pairs"]) >= len(source["values"])
            if "fallback" in node:
                branches.append(f"else -> {self.enum_member(node['target'], node['fallback'])}")
            elif not complete:
                described = source["name"] if source else "value"
                branches.append(f'else -> throw IllegalArgumentException("Unexpected {described}: $value")')
            parameter = type_name(source["name"]) if source else "String"
            body = indent("\n".join(branches), 4)
            code = f"private fun {name}(value: {parameter}): {target} = when (value) {{\n{body}\n}}"
            self.helpers[name] = (key, code)
        return name

    def _split(self, expr: str, separator: str, part) -> str:
        sep = quote(separator)
        if part == 0:
            return f"{operand(expr)}.substringBefore({sep})"
        if part == "rest":
            return f'{operand(expr)}.substringAfter({sep}, "")'
        if part == "last":
            return f"{operand(expr)}.substringAfterLast({sep})"
        return f'{operand(expr)}.split({sep}).getOrElse({part}) {{ "" }}'

    def _boolean(self, expr: str, true_values: list, origin: dict) -> str:
        enum_def = find_enum(self.plan["source"], origin["name"]) if origin["kind"] == "enum" else None
        values = [self.enum_member(enum_def, value) if enum_def else quote(value) for value in true_values]
        return f"{expr} == {values[0]}" if len(values) == 1 else f"{expr} in setOf({', '.join(values)})"

    def _epoch(self, expr: str, unit: str, to_date: bool, origin: dict, _to: dict) -> str:
        self.use("java.time.Instant")
        if to_date:
            whole = f"{operand(expr)}.toLong()" if _is_primitive(origin, "float") else expr
            instant = f"Instant.ofEpochSecond({whole})" if unit == "seconds" else f"Instant.ofEpochMilli({whole})"
            if self.target_date_time == "Instant":
                return instant
            self.use("java.time.ZoneOffset")
            if self.target_date_time == "OffsetDateTime":
                return f"{instant}.atOffset(ZoneOffset.UTC)"
            self.use(f"java.time.{self.target_date_time}")
            return f"{self.target_date_time}.ofInstant({instant}, ZoneOffset.UTC)"
        instant = operand(expr) if self.source_date_time == "Instant" else f"{operand(expr)}.toInstant()"
        return f"{instant}.epochSecond" if unit == "seconds" else f"{instant}.toEpochMilli()"

    def _arithmetic(self, expr: str, operator: str, value, type_ref: dict) -> str:
        if _is_primitive(type_ref, "decimal"):
            if operator == "/":
                self.use("java.math.BigDecimal")
                self.use("java.math.MathContext")
                return f"{operand(expr)}.divide(BigDecimal.valueOf({js_string(value)}L), MathContext.DECIMAL128)"
            return f"{operand(expr)} {operator} {js_string(value)}.toBigDecimal()"
        literal = f"{js_string(value)}.0" if _is_primitive(type_ref, "float") and _integral(value) else js_string(value)
        return f"{operand(expr)} {operator} {literal}"

    def _list(self, expr: str, item: str, element: str, is_map: bool, element_is_item: bool, container) -> str:
        is_set = (container or "").endswith("Set")
        if is_map:
            return (
                f"{operand(expr)}.toMap()"
                if element_is_item
                else f"{operand(expr)}.mapValues {{ (_, {item}) -> {element} }}"
            )
        if element_is_item:
            return f"{operand(expr)}.{'toSet()' if is_set else 'toList()'}"
        call = re.match(rf"^{item}\.(\w+)\(\)$", element)
        mapped = (
            f"{operand(expr)}.map {{ it.{call.group(1)}() }}"
            if call
            else f"{operand(expr)}.map {{ {item} -> {element} }}"
        )
        return f"{mapped}.toSet()" if is_set else mapped

    def _null_safe(self, expr: str, build, context: dict) -> str:
        marker = "\u0000"
        built = build(marker)
        if built.startswith(f"{marker}.") and marker not in built[1:]:
            return f"{operand(expr)}?{built[1:]}"
        return f"{operand(expr)}?.let {{ {context['variable']} -> {build(context['variable'])} }}"

    def _call(self, name: str, args: list[str], types: list[dict | None]) -> str:
        a = args[0] if args else None
        b = args[1] if len(args) > 1 else None
        c = args[2] if len(args) > 2 else None
        if name == "upper":
            return f"{operand(a)}.uppercase()"
        if name == "lower":
            return f"{operand(a)}.lowercase()"
        if name == "trim":
            return f"{operand(a)}.trim()"
        if name == "length":
            return f"{operand(a)}.length"
        if name == "concat":
            return _template(args, "")
        if name == "substring":
            return (
                f"{operand(a)}.substring({b})"
                if c is None
                else f"{operand(a)}.substring({b}, {operand(b)} + {operand(c)})"
            )
        if name == "replace":
            return f"{operand(a)}.replace({b}, {c})"
        if name in ("round", "floor", "ceil", "abs"):
            self.use(f"kotlin.math.{name}")
            return f"{name}({a})"
        if name == "min":
            return f"minOf({a}, {b})"
        if name == "max":
            return f"maxOf({a}, {b})"
        if name == "toString":
            return f"{operand(a)}.toString()"
        return f"{operand(a)}.toDouble()"

    def _syntax(self):
        return make_syntax(
            access=lambda base, _step, name: name if base == "this" else f"{base}.{name}",
            safe_access=lambda base, _step, name: f"{base}?.{name}",
            literal=self.literal,
            convert=self.convert,
            concat=_template,
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
            coalesce=lambda expr, fallback, _type: f"{expr} ?: {fallback}",
            null_safe=self._null_safe,
            unwrap=lambda expr, _type: f'requireNotNull({expr}) {{ "A required value is missing in the source" }}',
            placeholder=lambda _type, field: f'TODO("No value for {field["name"]} in the mapping")',
            expression=make_expression_syntax(
                binary=lambda operator, left, right: f"{left} {'?:' if operator == '??' else operator} {right}",
                not_=lambda value: f"!{operand(value)}",
                conditional=lambda condition, then, otherwise, _type: f"if ({condition}) {then} else {otherwise}",
                call=self._call,
            ),
        )

    def mapper_function(self, mapper: dict) -> str:
        context = roots("this")
        target = type_name(mapper["target"]["name"])
        lines: list[str] = []
        for assignment in mapper["assignments"]:
            code = self.emitter.assignment(assignment, context)
            if code is None:
                continue
            lines.append(f"{self.name(assignment['field'], 'target')} = {code},")
        signature = f"fun {type_name(mapper['source']['name'])}.{self.function_name(mapper)}(): {target}"
        if mapper["target"].get("construction") == "properties":
            statements = "\n".join(f"target.{_TRAILING_COMMA.sub('', line)}" for line in lines)
            return f"{signature} {{\n    val target = {target}()\n{indent(statements, 4)}\n    return target\n}}"
        if lines:
            return f"{signature} = {target}(\n{indent(chr(10).join(lines), 4)}\n)"
        return f"{signature} = {target}()"


def _generate(plan: dict, settings: dict) -> dict:
    writer = _Writer(plan, settings)
    functions = [writer.mapper_function(mapper) for mapper in plan["mappers"]]
    helpers = [code for _, code in writer.helpers.values()]
    pkg = option_value(kotlin_generator, plan, settings, "package")
    imports = "\n".join(f"import {item}" for item in sorted(writer.imports))
    header = "\n\n".join(part for part in [f"package {pkg}" if pkg else "", imports] if part != "")
    code = "\n\n".join(part for part in [header, *functions, *helpers] if part != "") + "\n"
    name = f"{type_name(plan['root']['source']['name'])}Mappers.kt"
    return {"files": [{"name": name, "code": code}], "notes": writer.emitter.notes}


def _defaults(plan: dict) -> dict:
    is_kotlin = (plan["target"].get("origin") or {}).get("language") == "kotlin"
    namespace = plan["root"]["target"].get("namespace") if is_kotlin else None
    return {"package": namespace} if namespace else {}


kotlin_generator = CodeGenerator(
    "kotlin",
    "Kotlin",
    "kotlin",
    ("extensions",),
    (GeneratorOption("package", ("",), "text"),),
    _generate,
    _defaults,
)
