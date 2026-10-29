"""Java mappers: a class of static methods, or a MapStruct interface. Mirrors
web/src/core/generate/languages/java.ts."""

import json
import math
import re

from ...js import js_string
from ...model.naming import to_screaming_snake_case
from ...model.schema import find_enum
from ..emitter import Emitter, indent, make_expression_syntax, make_syntax, quote, roots
from ..naming import NamingRules, field_name, is_valid_identifier, type_name
from ..types import CodeGenerator, GeneratorOption, option_value

RESERVED = frozenset(
    {
        "abstract",
        "assert",
        "boolean",
        "break",
        "byte",
        "case",
        "catch",
        "char",
        "class",
        "const",
        "continue",
        "default",
        "do",
        "double",
        "else",
        "enum",
        "extends",
        "final",
        "finally",
        "float",
        "for",
        "goto",
        "if",
        "implements",
        "import",
        "instanceof",
        "int",
        "interface",
        "long",
        "native",
        "new",
        "package",
        "private",
        "protected",
        "public",
        "return",
        "short",
        "static",
        "strictfp",
        "super",
        "switch",
        "synchronized",
        "this",
        "throw",
        "throws",
        "transient",
        "try",
        "void",
        "volatile",
        "while",
        "record",
        "var",
        "yield",
    }
)

NAMING = NamingRules("java", "camelCase", RESERVED, lambda name: f"{name}_")


def _is_number(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("integer", "float", "decimal")


def _is_primitive(type_ref: dict, *names: str) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in names


_DATE_TIME_CLASSES = ("OffsetDateTime", "LocalDateTime", "ZonedDateTime", "Instant", "Date")


def _date_time_class(schema: dict) -> str:
    """The Java class used for date-times on one side: the one the models declare, OffsetDateTime otherwise."""
    for model in schema["models"]:
        for field in model["fields"]:
            if _is_primitive(field["type"], "datetime") and (schema.get("origin") or {}).get("language") == "java":
                original = field.get("originalType")
                declared = re.sub(r"^.*\.", "", original) if original else None
                if declared and declared in _DATE_TIME_CLASSES:
                    return declared
    return "OffsetDateTime"


_SIMPLE = re.compile(r'^[\w.()"]+$')


def operand(code: str) -> str:
    return code if _SIMPLE.match(code) and " " not in code else f"({code})"


def _number(value) -> str:
    return js_string(value)


def _is_integral(value) -> bool:
    return float(value).is_integer()


def _capitalize(name: str) -> str:
    return name[:1].upper() + name[1:]


_LOWER = re.compile(r"[a-z]")
_PLAIN_SEPARATOR = re.compile(r"^[\w ,;:-]$")
_CALL = re.compile(r"^(\w+)\((\w+)\)$")
_ANY_REMAINING = "MappingConstants.ANY_REMAINING"
_THROW = "MappingConstants.THROW_EXCEPTION"
_DECIMAL_METHODS = {"+": "add", "-": "subtract", "*": "multiply", "/": "divide"}


class JavaWriter:
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

    def use(self, name: str) -> None:
        self.imports[name] = None

    def class_name(self, model: dict) -> str:
        """A model's name in code: Outer.Inner for nested classes."""
        outer = (model.get("metadata") or {}).get("outer")
        return f"{outer}.{type_name(model['name'])}" if isinstance(outer, str) else type_name(model["name"])

    def enum_class(self, enum_def: dict) -> str:
        return type_name(enum_def["name"])

    def enum_constant(self, enum_def: dict, name: str) -> str:
        # Enums from documents are written as Java constants: "in_progress" → IN_PROGRESS
        if is_valid_identifier(name) and not (enum_def.get("kind") == "literals" and _LOWER.search(name)):
            return name
        return to_screaming_snake_case(name) or "VALUE"

    def method_name(self, mapper: dict) -> str:
        return f"to{type_name(mapper['target']['name'])}"

    def _getter(self, owner: dict, field: dict, name: str) -> str:
        style = (owner.get("metadata") or {}).get("accessors") or "getters"
        if style == "record":
            return f"{name}()"
        if style == "fields":
            return name
        primitive_boolean = (
            _is_primitive(field["type"], "boolean")
            and not field["nullable"]
            and (self.plan["source"].get("origin") or {}).get("language") == "java"
        )
        return f"{'is' if primitive_boolean else 'get'}{_capitalize(name)}()"

    def literal(self, value, type_ref: dict) -> str:
        if value is None:
            return "null"
        if type_ref["kind"] == "enum" and isinstance(value, str):
            enum_def = find_enum(self.plan["target"], type_ref["name"])
            if enum_def:
                return f"{self.enum_class(enum_def)}.{self.enum_constant(enum_def, value)}"
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if _is_primitive(type_ref, "decimal"):
                self.use("java.math.BigDecimal")
                return f"new BigDecimal({quote(_number(value))})"
            if _is_primitive(type_ref, "float"):
                return f"{_number(value)}.0" if _is_integral(value) else _number(value)
            if _is_primitive(type_ref, "integer") and type_ref.get("bits") == 64:
                return f"{_number(value)}L"
            return _number(value)
        if isinstance(value, str) and _is_primitive(type_ref, "datetime"):
            self.use(f"java.time.{self.target_date_time}")
            return f"{self.target_date_time}.parse({quote(value)})"
        return quote(value) if isinstance(value, str) else js_string(value)

    def convert(self, expr: str, origin: dict, to: dict) -> str:
        if _is_number(origin) and _is_number(to):
            if to["name"] == "decimal":
                if origin["name"] == "decimal":
                    return expr
                self.use("java.math.BigDecimal")
                return f"BigDecimal.valueOf({expr})"
            if origin["name"] == "decimal":
                if to["name"] == "integer":
                    return (
                        f"{operand(expr)}.intValueExact()"
                        if to.get("bits") == 32
                        else f"{operand(expr)}.longValueExact()"
                    )
                return f"{operand(expr)}.doubleValue()"
            if to["name"] == "float":
                return expr if origin["name"] == "float" else f"(double) {operand(expr)}"
            # To an integer: from a float drops the decimals; from a wider integer it must fit
            if origin["name"] == "float":
                return f"(int) (double) {operand(expr)}" if to.get("bits") == 32 else f"(long) (double) {operand(expr)}"
            if to.get("bits") == 32 and origin.get("bits") != 32:
                return f"Math.toIntExact({expr})"
            if to.get("bits") == 64 and origin.get("bits") != 64:
                return f"(long) {operand(expr)}"
            return expr
        if _is_primitive(to, "string"):
            if origin["kind"] == "enum":
                return f"{operand(expr)}.name()"
            if _is_primitive(origin, "decimal"):
                return f"{operand(expr)}.toPlainString()"
            if _is_primitive(origin, "string"):
                return expr
            if _is_primitive(origin, "datetime", "date", "time", "uuid", "duration"):
                return f"{operand(expr)}.toString()"
            return f"String.valueOf({expr})"
        if _is_primitive(origin, "string", "any"):
            text = f"String.valueOf({expr})" if _is_primitive(origin, "any") else expr
            if to["kind"] == "primitive":
                name = to["name"]
                if name == "integer":
                    return f"Integer.parseInt({text})" if to.get("bits") == 32 else f"Long.parseLong({text})"
                if name == "float":
                    return f"Double.parseDouble({text})"
                if name == "decimal":
                    self.use("java.math.BigDecimal")
                    return f"new BigDecimal({text})"
                if name == "datetime":
                    self.use(f"java.time.{self.target_date_time}")
                    return f"{self.target_date_time}.parse({text})"
                if name == "date":
                    self.use("java.time.LocalDate")
                    return f"LocalDate.parse({text})"
                if name == "time":
                    self.use("java.time.LocalTime")
                    return f"LocalTime.parse({text})"
                if name == "duration":
                    self.use("java.time.Duration")
                    return f"Duration.parse({text})"
                if name == "uuid":
                    self.use("java.util.UUID")
                    return f"UUID.fromString({text})"
            if to["kind"] == "enum":
                enum_def = find_enum(self.plan["target"], to["name"])
                return f"{self.enum_class(enum_def) if enum_def else type_name(to['name'])}.valueOf({text})"
        if _is_primitive(origin, "date") and _is_primitive(to, "datetime"):
            self.use("java.time.ZoneOffset")
            if self.target_date_time == "LocalDateTime":
                return f"{operand(expr)}.atStartOfDay()"
            return f"{operand(expr)}.atStartOfDay().atOffset(ZoneOffset.UTC)"
        if _is_primitive(origin, "datetime") and _is_primitive(to, "date"):
            return f"{operand(expr)}.toLocalDate()"
        if (
            _is_primitive(origin, "datetime")
            and _is_primitive(to, "datetime")
            and self.source_date_time != self.target_date_time
        ):
            self.use(f"java.time.{self.target_date_time}")
            self.use("java.time.ZoneOffset")
            if self.target_date_time == "Instant":
                return f"{operand(expr)}.toInstant()"
            instant = expr if self.source_date_time == "Instant" else f"{operand(expr)}.toInstant()"
            return f"{self.target_date_time}.ofInstant({instant}, ZoneOffset.UTC)"
        if _is_primitive(origin, "boolean") and _is_primitive(to, "integer"):
            return f"{operand(expr)} ? 1 : 0"
        return expr

    def _enum_helper(self, node: dict) -> str:
        source = node.get("source")
        base = f"to{self.enum_class(node['target'])}"
        key = json.dumps([node["pairs"], node.get("fallback"), source["name"] if source else None])
        name = base
        n = 2
        while name in self.helpers and self.helpers[name][0] != key:
            name = f"{base}{n}"
            n += 1
        if name not in self.helpers:
            target = self.enum_class(node["target"])
            cases = [
                f"            case {self.enum_constant(source, pair['from']) if source else quote(pair['from'])}"
                f" -> {target}.{self.enum_constant(node['target'], pair['to'])};"
                for pair in node["pairs"]
            ]
            if "fallback" in node:
                fallback = f"            default -> {target}.{self.enum_constant(node['target'], node['fallback'])};"
            else:
                described = source["name"] if source else "value"
                fallback = (
                    f'            default -> throw new IllegalArgumentException("Unexpected {described}: " + value);'
                )
            parameter = self.enum_class(source) if source else "String"
            body = "\n".join([*cases, fallback])
            code = (
                f"    private static {target} {name}({parameter} value) {{\n"
                f"        return switch (value) {{\n{body}\n        }};\n    }}"
            )
            self.helpers[name] = (key, code)
        return name

    def _access(self, base: str, step: dict, name: str) -> str:
        read = f"{base}.{self._getter(step['owner'], step['field'], name)}"
        # A getter returning Optional<T>: the mapping works with the value or null
        return f"{read}.orElse(null)" if (step["field"].get("originalType") or "").startswith("Optional<") else read

    def _split(self, expr: str, separator: str, part) -> str:
        sep = quote(separator)
        if part == 0:
            pattern = sep if _PLAIN_SEPARATOR.match(separator) else f"java.util.regex.Pattern.quote({sep})"
            return f"{operand(expr)}.split({pattern}, -1)[0]"
        if part == "last":
            return f"{operand(expr)}.substring({operand(expr)}.lastIndexOf({sep}) + {len(separator)})"
        if part == "rest":
            rest = f"{operand(expr)}.substring({operand(expr)}.indexOf({sep}) + {len(separator)})"
            return f'{operand(expr)}.contains({sep}) ? {rest} : ""'
        return f"{operand(expr)}.split(java.util.regex.Pattern.quote({sep}), -1)[{part}]"

    def _boolean(self, expr: str, true_values: list, origin: dict) -> str:
        enum_def = find_enum(self.plan["source"], origin["name"]) if origin["kind"] == "enum" else None
        if enum_def:
            return " || ".join(
                f"{expr} == {self.enum_class(enum_def)}.{self.enum_constant(enum_def, value)}" for value in true_values
            )
        if len(true_values) == 1:
            return f"{quote(true_values[0])}.equals({expr})"
        self.use("java.util.Set")
        return f"Set.of({', '.join(quote(value) for value in true_values)}).contains({expr})"

    def _epoch(self, expr: str, unit: str, to_date: bool, origin: dict, _to: dict) -> str:
        self.use("java.time.Instant")
        if to_date:
            # Instant takes a long: a floating number of seconds is truncated
            whole = f"(long) {operand(expr)}" if _is_primitive(origin, "float") else expr
            instant = f"Instant.ofEpochSecond({whole})" if unit == "seconds" else f"Instant.ofEpochMilli({whole})"
            if self.target_date_time == "Instant":
                return instant
            self.use(f"java.time.{self.target_date_time}")
            self.use("java.time.ZoneOffset")
            return f"{self.target_date_time}.ofInstant({instant}, ZoneOffset.UTC)"
        instant = expr if self.source_date_time == "Instant" else f"{operand(expr)}.toInstant()"
        return f"{operand(instant)}.getEpochSecond()" if unit == "seconds" else f"{operand(instant)}.toEpochMilli()"

    def _arithmetic(self, expr: str, operator: str, value, type_ref: dict) -> str:
        if _is_primitive(type_ref, "decimal"):
            self.use("java.math.BigDecimal")
            method = _DECIMAL_METHODS.get(operator, "undefined")
            if operator == "/":
                self.use("java.math.MathContext")
            context = ", MathContext.DECIMAL128" if operator == "/" else ""
            return f"{operand(expr)}.{method}(BigDecimal.valueOf({_number(value)}){context})"
        literal = f"{_number(value)}.0" if _is_primitive(type_ref, "float") and _is_integral(value) else _number(value)
        return f"{operand(expr)} {operator} {literal}"

    def _list(self, expr: str, item: str, element: str, is_map: bool, element_is_item: bool, container) -> str:
        is_set = (container or "").endswith("Set")
        if is_map:
            if element_is_item:
                self.use("java.util.HashMap")
                return f"new HashMap<>({expr})"
            self.use("java.util.Map")
            self.use("java.util.stream.Collectors")
            value = element.replace(item, "entry.getValue()")
            return f"{operand(expr)}.entrySet().stream().collect(Collectors.toMap(Map.Entry::getKey, entry -> {value}))"
        if element_is_item:
            self.use("java.util.HashSet" if is_set else "java.util.ArrayList")
            return f"new {'HashSet' if is_set else 'ArrayList'}<>({expr})"
        call = _CALL.match(element)
        mapping = (
            f"{self.mapper_class()}::{call.group(1)}" if call and call.group(2) == item else f"{item} -> {element}"
        )
        if is_set:
            self.use("java.util.stream.Collectors")
            return f"{operand(expr)}.stream().map({mapping}).collect(Collectors.toSet())"
        return f"{operand(expr)}.stream().map({mapping}).toList()"

    def _coalesce(self, expr: str, fallback: str, _type: dict) -> str:
        self.use("java.util.Objects")
        return f"Objects.requireNonNullElse({expr}, {fallback})"

    def _unwrap(self, expr: str, _type: dict) -> str:
        self.use("java.util.Objects")
        return f"Objects.requireNonNull({expr})"

    def _binary(self, operator: str, left: str, right: str) -> str:
        if operator in ("==", "!="):
            self.use("java.util.Objects")
            return f"{'!' if operator == '!=' else ''}Objects.equals({left}, {right})"
        if operator == "??":
            self.use("java.util.Objects")
            return f"Objects.requireNonNullElse({left}, {right})"
        return f"{left} {operator} {right}"

    def _call(self, name: str, args: list[str], types: list[dict | None]) -> str:
        a = args[0] if args else None
        b = args[1] if len(args) > 1 else None
        c = args[2] if len(args) > 2 else None
        if name == "upper":
            return f"{operand(a)}.toUpperCase()"
        if name == "lower":
            return f"{operand(a)}.toLowerCase()"
        if name == "trim":
            return f"{operand(a)}.strip()"
        if name == "length":
            return f"{operand(a)}.length()"
        if name == "concat":
            return " + ".join(f"String.valueOf({arg})" for arg in args)
        if name == "substring":
            return (
                f"{operand(a)}.substring({b})"
                if c is None
                else f"{operand(a)}.substring({b}, {operand(b)} + {operand(c)})"
            )
        if name == "replace":
            return f"{operand(a)}.replace({b}, {c})"
        if name in ("round", "floor", "ceil", "abs", "min", "max"):
            return f"Math.{name}({', '.join(args)})"
        if name == "toString":
            return f"String.valueOf({a})"
        return f"Double.parseDouble({a})"

    def _syntax(self):
        return make_syntax(
            access=self._access,
            literal=self.literal,
            convert=self.convert,
            concat=lambda parts, separator: f" + {quote(separator)} + ".join(parts),
            split=self._split,
            boolean=self._boolean,
            enum_map=lambda expr, node, _origin: f"{self._enum_helper(node)}({expr})",
            epoch=self._epoch,
            arithmetic=self._arithmetic,
            mapper_call=lambda mapper, expr: f"{self.method_name(mapper)}({expr})",
            list=self._list,
            coalesce=self._coalesce,
            null_safe=lambda expr, build, _context: f"{operand(expr)} != null ? {build(expr)} : null",
            unwrap=self._unwrap,
            placeholder=lambda type_ref, _field: self.placeholder(type_ref),
            expression=make_expression_syntax(
                binary=self._binary,
                not_=lambda value: f"!{operand(value)}",
                conditional=lambda condition, then, otherwise, _type: f"{condition} ? {then} : {otherwise}",
                call=self._call,
            ),
        )

    def placeholder(self, type_ref: dict) -> str:
        if type_ref["kind"] == "array":
            self.use("java.util.List")
            return "List.of()"
        if type_ref["kind"] == "map":
            self.use("java.util.Map")
            return "Map.of()"
        if type_ref["kind"] == "primitive":
            name = type_ref["name"]
            if name == "string":
                return '""'
            if name == "integer":
                return "0L" if type_ref.get("bits") == 64 else "0"
            if name == "float":
                return "0.0"
            if name == "boolean":
                return "false"
            if name == "decimal":
                self.use("java.math.BigDecimal")
                return "BigDecimal.ZERO"
        return "null"

    def mapper_class(self) -> str:
        return f"{type_name(self.plan['root']['source']['name'])}Mapper"

    def _build(self, mapper: dict, values: list[tuple[dict, str | None]]) -> list[str]:
        """target.setName(value);, a builder call, or constructor arguments, depending on the target model."""
        target_model = mapper["target"]
        target = self.class_name(target_model)

        def comments(assignment: dict) -> list[str]:
            name = assignment["field"]["name"]
            if assignment["missing"]:
                return [f'// TODO: no value for "{name}" in the mapping']
            if assignment["unsafeNull"]:
                return [f'// "{name}" is required: fails if the source is missing']
            return []

        metadata = target_model.get("metadata") or {}
        if target_model.get("construction") == "positional" or target_model["kind"] == "record":
            args = [line for assignment, code in values for line in [*comments(assignment), f"{code or 'null'},"]]
            if args:
                args[-1] = re.sub(r",$", "", args[-1])
            lines = [f"return new {target}(", *indent("\n".join(args), 8).split("\n"), ");"]
            return [line for line in lines if line != ""]
        if metadata.get("builder"):
            calls = [
                line
                for assignment, code in values
                if code is not None
                for line in [*comments(assignment), f".{self.name(assignment['field'], 'target')}({code})"]
            ]
            return [f"return {target}.builder()", *(f"        {line}" for line in calls), "        .build();"]
        fields = metadata.get("accessors") == "fields"
        lines = [f"{target} target = new {target}();"]
        for assignment, code in values:
            if code is None:
                continue
            lines.extend(comments(assignment))
            name = self.name(assignment["field"], "target")
            lines.append(f"target.{name} = {code};" if fields else f"target.set{_capitalize(name)}({code});")
        lines.append("return target;")
        return lines

    def mapper_method(self, mapper: dict) -> str:
        context = roots("source")
        values = [(assignment, self.emitter.assignment(assignment, context)) for assignment in mapper["assignments"]]
        body = ["if (source == null) {", "    return null;", "}", *self._build(mapper, values)]
        return (
            f"    public static {self.class_name(mapper['target'])} {self.method_name(mapper)}"
            f"({self.class_name(mapper['source'])} source) {{\n{indent(chr(10).join(body), 8)}\n    }}"
        )

    def model_imports(self) -> list[str]:
        imports: dict[str, None] = {}

        def add(schema: dict, model: dict) -> None:
            if (schema.get("origin") or {}).get("language") != "java" or not model.get("namespace"):
                return
            outer = (model.get("metadata") or {}).get("outer")
            first = outer.split(".")[0] if isinstance(outer, str) else type_name(model["name"])
            imports[f"{model['namespace']}.{first}"] = None

        for mapper in self.plan["mappers"]:
            add(self.plan["source"], mapper["source"])
            add(self.plan["target"], mapper["target"])
        for enum_def in self.plan["enums"]["source"]:
            add(self.plan["source"], enum_def)
        for enum_def in self.plan["enums"]["target"]:
            add(self.plan["target"], enum_def)
        return list(imports)

    def header(self) -> str:
        pkg = option_value(java_generator, self.plan, self.settings, "package")
        merged = dict.fromkeys([*self.imports, *self.model_imports()])
        imports = sorted(item for item in merged if not item.startswith(f"{pkg}.") or "." in item[len(pkg) + 1 :])
        java = [item for item in imports if item.startswith("java.")]
        other = [item for item in imports if not item.startswith("java.")]
        blocks = [
            f"package {pkg};" if pkg else "",
            "\n".join(f"import {item};" for item in other),
            "\n".join(f"import {item};" for item in java),
        ]
        return "\n\n".join(block for block in blocks if block != "")


def _generate_manual(plan: dict, settings: dict) -> dict:
    writer = JavaWriter(plan, settings)
    methods = [writer.mapper_method(mapper) for mapper in plan["mappers"]]
    helpers = [code for _, code in writer.helpers.values()]
    name = writer.mapper_class()
    body = "\n\n".join([f"    private {name}() {{\n    }}", *methods, *helpers])
    parts = [writer.header(), f"public final class {name} {{\n\n{body}\n}}"]
    code = "\n\n".join(part for part in parts if part != "") + "\n"
    return {"files": [{"name": f"{name}.java", "code": code}], "notes": writer.emitter.notes}


def _source_path(writer: JavaWriter, node: dict) -> str | None:
    if node["k"] == "path":
        return ".".join(writer.name(step["field"], "source") for step in node["steps"])
    if node["k"] == "self":
        return "."
    return None


def _generate_mapstruct(plan: dict, settings: dict) -> dict:
    """MapStruct: @Mapping only where names differ or a transformation is needed; nested objects and lists are
    mapped by the methods of the other model pairs."""
    writer = JavaWriter(plan, settings)
    component = option_value(java_generator, plan, settings, "componentModel")
    methods: list[str] = []
    value_mappings: dict[str, str] = {}

    for mapper in plan["mappers"]:
        annotations: list[str] = []
        for assignment in mapper["assignments"]:
            target = writer.name(assignment["field"], "target")
            value = assignment["value"]
            attributes: list[str] = []
            if not value:
                if assignment["missing"]:
                    annotations.append(f'    // TODO: no value for "{assignment["field"]["name"]}" in the mapping')
                    writer.emitter.notes.append(
                        {"code": "missingValue", "params": {"field": assignment["field"]["name"]}}
                    )
                annotations.append(f"    @Mapping(target = {quote(target)}, ignore = true)")
                continue
            # Values MapStruct converts by itself: a field read as is, a nested object or list mapped by another
            # method, an enum by its @ValueMapping
            simple = value["value"] if value["k"] in ("convert", "coalesce") else value
            inner = simple["value"] if simple["k"] == "convert" else simple
            if inner["k"] in ("path", "self"):
                direct = inner
            elif inner["k"] in ("mapper", "list", "enumMap"):
                direct = inner["value"]
            else:
                direct = None
            path = _source_path(writer, direct) if direct else None
            element_ok = inner["k"] != "list" or inner["element"]["k"] in ("mapper", "self", "convert")
            if value["k"] == "literal":
                if value["value"] is None:
                    attributes.append('expression = "java(null)"')
                else:
                    attributes.append(f"constant = {quote(js_string(value['value']))}")
            elif path is not None and element_ok:
                if path != target:
                    attributes.append(f"source = {quote(path)}")
                fallback = value.get("fallback") if value["k"] == "coalesce" else None
                if fallback and fallback["k"] == "literal" and fallback["value"] is not None:
                    attributes.append(f"defaultValue = {quote(js_string(fallback['value']))}")
                if inner["k"] == "enumMap":
                    source = inner.get("source")
                    key = f"{source['name'] if source else 'String'}->{inner['target']['name']}"
                    if key not in value_mappings:
                        lines = []
                        for pair in inner["pairs"]:
                            origin = quote(writer.enum_constant(source, pair["from"]) if source else pair["from"])
                            to = quote(writer.enum_constant(inner["target"], pair["to"]))
                            lines.append(f"    @ValueMapping(source = {origin}, target = {to})")
                        if "fallback" in inner:
                            constant = quote(writer.enum_constant(inner["target"], inner["fallback"]))
                            lines.append(f"    @ValueMapping(source = {_ANY_REMAINING}, target = {constant})")
                        # Values without a pair fail at run time, as in the manual mapper (MapStruct 1.5+)
                        elif len(inner["pairs"]) < (len(source["values"]) if source else math.inf):
                            lines.append(f"    @ValueMapping(source = {_ANY_REMAINING}, target = {_THROW})")
                        enum_class = writer.enum_class(inner["target"])
                        parameter = writer.enum_class(source) if source else "String"
                        lines.append(f"    {enum_class} to{enum_class}({parameter} value);")
                        value_mappings[key] = "\n".join(lines)
                if not attributes:
                    continue
            else:
                # Anything else is written as a Java expression over the source parameter
                expression = writer.emitter.value(value, roots("source"))
                attributes.append(f"expression = {quote(f'java({expression})')}")
            annotations.append(f"    @Mapping(target = {quote(target)}, {', '.join(attributes)})")
        methods.append(
            "\n".join(
                [
                    *annotations,
                    f"    {writer.class_name(mapper['target'])} {writer.method_name(mapper)}"
                    f"({writer.class_name(mapper['source'])} source);",
                ]
            )
        )

    java_imports = list(writer.imports)
    expression_classes = [
        item
        for item in java_imports
        if item not in ("java.util.Set", "java.util.List", "java.util.Map", "java.util.stream.Collectors")
    ]
    mapper_attributes: list[str] = []
    if component != "default":
        mapper_attributes.append(f"componentModel = {quote(component)}")
    if expression_classes:
        listed = ", ".join(f"{item.split('.')[-1]}.class" for item in expression_classes)
        mapper_attributes.append(f"imports = {{{listed}}}")
    uses_constants = any("MappingConstants" in item for item in value_mappings.values())
    mapstruct = [
        "org.mapstruct.Mapper",
        "org.mapstruct.Mapping",
        *(["org.mapstruct.ValueMapping"] if value_mappings else []),
        *(["org.mapstruct.MappingConstants"] if uses_constants else []),
    ]
    pkg = option_value(java_generator, plan, settings, "package")
    imports = sorted(dict.fromkeys([*java_imports, *writer.model_imports(), *mapstruct]))
    blocks = [
        f"package {pkg};" if pkg else "",
        "\n".join(f"import {item};" for item in imports if not item.startswith("java.")),
        "\n".join(f"import {item};" for item in imports if item.startswith("java.")),
    ]
    header = "\n\n".join(block for block in blocks if block != "")
    name = writer.mapper_class()
    annotation = f"@Mapper({', '.join(mapper_attributes)})" if mapper_attributes else "@Mapper"
    members = "\n\n".join([*methods, *value_mappings.values()])
    code = f"{header}\n\n{annotation}\npublic interface {name} {{\n\n{members}\n}}\n"
    return {"files": [{"name": f"{name}.java", "code": code}], "notes": writer.emitter.notes}


def _defaults(plan: dict) -> dict:
    is_java = (plan["target"].get("origin") or {}).get("language") == "java"
    namespace = plan["root"]["target"].get("namespace") if is_java else None
    return {"package": namespace} if namespace else {}


java_generator = CodeGenerator(
    "java",
    "Java",
    "java",
    ("manual", "mapstruct"),
    (
        GeneratorOption("package", ("",), "text"),
        GeneratorOption("componentModel", ("default", "spring", "cdi", "jakarta")),
    ),
    lambda plan, settings: (
        _generate_mapstruct(plan, settings) if settings["mode"] == "mapstruct" else _generate_manual(plan, settings)
    ),
    _defaults,
)
