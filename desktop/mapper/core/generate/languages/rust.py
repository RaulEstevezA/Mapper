"""Rust From implementations. Mirrors web/src/core/generate/languages/rust.ts."""

import json
import re

from ...js import js_string
from ...model.naming import to_pascal_case, to_snake_case
from ...model.schema import find_enum
from ..emitter import Emitter, indent, make_expression_syntax, make_syntax, quote, roots
from ..naming import NamingRules, field_name, is_valid_identifier, type_name
from ..types import CodeGenerator, GeneratorOption, option_value

RESERVED = frozenset(
    "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref "
    "return self Self static struct super trait true type unsafe use where while async await dyn".split()
)

NAMING = NamingRules("rust", "snake_case", RESERVED, lambda name: f"r#{name}")


def _is_primitive(type_ref: dict, *names: str) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in names


def _is_number(type_ref: dict) -> bool:
    return _is_primitive(type_ref, "integer", "float", "decimal")


def _is_copy(type_ref: dict) -> bool:
    """Values copied without .clone()."""
    return _is_primitive(type_ref, "integer", "float", "boolean")


def _rust_number(type_ref: dict) -> str:
    """The Rust type of a value, for numeric casts."""
    if type_ref["kind"] != "primitive":
        return "i64"
    bits = type_ref.get("bits")
    if type_ref["name"] == "float":
        return "f32" if bits == 32 else "f64"
    if type_ref["name"] == "decimal":
        return "Decimal"
    return {32: "i32", 16: "i16", 8: "i8"}.get(bits, "i64")


_SOURCE_FIELD = re.compile(r"^source(\.\w+)+$")
_EXPECT = re.compile(r'\.expect\("a required value is missing in the source"\)$')
_UPPER_START = re.compile(r"^[A-Z]")
_BRACES = re.compile(r"[{}]")
MISSING_MESSAGE = '.expect("a required value is missing in the source")'


def _reference(expr: str) -> str:
    """A reference to a value: fields read from source are borrowed; closure parameters already are references."""
    return f"&{expr}" if _SOURCE_FIELD.match(expr) else expr


def _integral(value) -> bool:
    return float(value).is_integer()


def _placeholder(name: str) -> str:
    message = quote(f"no value for {name} in the mapping")
    return f"todo!({message})"


class _Writer:
    def __init__(self, plan: dict, settings: dict):
        self.plan = plan
        self.settings = settings
        self.uses: set[str] = set()
        self.helpers: dict[str, tuple[str, str]] = {}
        self.emitter = Emitter(self._syntax(), lambda field, _owner, side: self.name(field, side))

    def name(self, field: dict, side: str) -> str:
        schema = self.plan["source"] if side == "source" else self.plan["target"]
        return field_name(field, schema, NAMING, self.settings["naming"])

    def variant(self, enum_def: dict, name: str) -> str:
        keep = is_valid_identifier(name) and _UPPER_START.match(name) and "_" not in name
        return f"{type_name(enum_def['name'])}::{name if keep else to_pascal_case(name) or 'Value'}"

    def literal(self, value, type_ref: dict) -> str:
        if value is None:
            return "None"
        if type_ref["kind"] == "enum" and isinstance(value, str):
            enum_def = find_enum(self.plan["target"], type_ref["name"])
            if enum_def:
                return self.variant(enum_def, value)
        if isinstance(value, bool):
            return js_string(value)
        if isinstance(value, (int, float)):
            if _is_primitive(type_ref, "decimal"):
                self.uses.add("rust_decimal::Decimal")
                if _integral(value):
                    return f"Decimal::from({js_string(value)})"
                return f"Decimal::from_str_exact({quote(js_string(value))}).unwrap()"
            return (
                f"{js_string(value)}.0" if _is_primitive(type_ref, "float") and _integral(value) else js_string(value)
            )
        return f"{quote(value)}.to_string()"

    def _parse(self, expr: str, type_text: str, what: str) -> str:
        return f"{expr}.parse::<{type_text}>().expect({quote(f'{what} is not valid')})"

    def convert(self, expr: str, origin: dict, to: dict) -> str:
        if _is_number(origin) and _is_number(to):
            if _is_primitive(to, "decimal"):
                if _is_primitive(origin, "decimal"):
                    return expr
                self.uses.add("rust_decimal::Decimal")
                if _is_primitive(origin, "float"):
                    return f'Decimal::try_from({expr}).expect("number out of range")'
                return f"Decimal::from({expr})"
            if _is_primitive(origin, "decimal"):
                self.uses.add("rust_decimal::prelude::ToPrimitive")
                method = "to_f64" if _is_primitive(to, "float") else "to_i64"
                return f'{expr}.{method}().expect("number out of range")'
            return expr if _rust_number(origin) == _rust_number(to) else f"{expr} as {_rust_number(to)}"
        if _is_primitive(to, "string"):
            if _is_primitive(origin, "string"):
                return f"{expr}.clone()"
            if origin["kind"] == "enum":
                return f'format!("{{:?}}", {expr})'
            if _is_primitive(origin, "datetime"):
                return f"{expr}.to_rfc3339()"
            return f"{expr}.to_string()"
        if _is_primitive(origin, "string"):
            if _is_number(to):
                if _is_primitive(to, "decimal"):
                    self.uses.add("rust_decimal::Decimal")
                return self._parse(expr, _rust_number(to), "number")
            if _is_primitive(to, "datetime"):
                self.uses.add("chrono::DateTime")
                self.uses.add("chrono::Utc")
                return self._parse(expr, "DateTime<Utc>", "date and time")
            if _is_primitive(to, "date"):
                self.uses.add("chrono::NaiveDate")
                return self._parse(expr, "NaiveDate", "date")
            if _is_primitive(to, "uuid"):
                self.uses.add("uuid::Uuid")
                return f'Uuid::parse_str({expr}).expect("id is not valid")'
            if to["kind"] == "enum":
                return self._parse(expr, type_name(to["name"]), "value")
        if _is_primitive(origin, "boolean") and _is_primitive(to, "integer"):
            return f"{expr} as {_rust_number(to)}"
        if _is_primitive(origin, "datetime") and _is_primitive(to, "date"):
            return f"{expr}.date_naive()"
        return expr if _is_copy(origin) else f"{expr}.clone()"

    def _enum_helper(self, node: dict) -> str:
        source = node.get("source")
        name = f"to_{to_snake_case(node['target']['name'])}"
        key = json.dumps([node["pairs"], node.get("fallback"), source["name"] if source else None])
        unique = name
        n = 2
        while unique in self.helpers and self.helpers[unique][0] != key:
            unique = f"{name}_{n}"
            n += 1
        if unique not in self.helpers:
            arms = []
            for pair in node["pairs"]:
                origin = self.variant(source, pair["from"]) if source else quote(pair["from"])
                arms.append(f"{origin} => {self.variant(node['target'], pair['to'])},")
            complete = source is not None and len(node["pairs"]) >= len(source["values"])
            if "fallback" in node:
                arms.append(f"_ => {self.variant(node['target'], node['fallback'])},")
            elif not complete:
                described = source["name"] if source else "value"
                arms.append(f'_ => panic!("unexpected {described}: {{:?}}", value),')
            parameter = f"&{type_name(source['name'])}" if source else "&str"
            body = indent("\n".join(arms), 8)
            target = type_name(node["target"]["name"])
            code = f"fn {unique}(value: {parameter}) -> {target} {{\n    match value {{\n{body}\n    }}\n}}"
            self.helpers[unique] = (key, code)
        return unique

    def _concat(self, parts: list[str], separator: str) -> str:
        doubled = _BRACES.sub(lambda match: match.group(0) * 2, separator)
        return f"format!({quote(doubled.join('{}' for _ in parts))}, {', '.join(parts)})"

    def _split(self, expr: str, separator: str, part) -> str:
        sep = quote(separator)
        if part == 0:
            return f"{expr}.split({sep}).next().unwrap_or_default().to_string()"
        if part == "last":
            return f"{expr}.rsplit({sep}).next().unwrap_or_default().to_string()"
        if part == "rest":
            return f"{expr}.split_once({sep}).map(|(_, rest)| rest).unwrap_or_default().to_string()"
        return f"{expr}.split({sep}).nth({part}).unwrap_or_default().to_string()"

    def _boolean(self, expr: str, true_values: list, origin: dict) -> str:
        enum_def = find_enum(self.plan["source"], origin["name"]) if origin["kind"] == "enum" else None
        if enum_def:
            return f"matches!({expr}, {' | '.join(self.variant(enum_def, value) for value in true_values)})"
        return f"matches!({expr}.as_str(), {' | '.join(quote(value) for value in true_values)})"

    def _epoch(self, expr: str, unit: str, to_date: bool, origin: dict, _to: dict) -> str:
        self.uses.add("chrono::DateTime")
        if to_date:
            whole = f"{expr} as i64" if _is_primitive(origin, "float") else expr
            if unit == "seconds":
                return f'DateTime::from_timestamp({whole}, 0).expect("timestamp out of range")'
            return f'DateTime::from_timestamp_millis({whole}).expect("timestamp out of range")'
        return f"{expr}.timestamp()" if unit == "seconds" else f"{expr}.timestamp_millis()"

    def _arithmetic(self, expr: str, operator: str, value, type_ref: dict) -> str:
        if _is_primitive(type_ref, "decimal"):
            self.uses.add("rust_decimal::Decimal")
            return f"{expr} {operator} Decimal::from({js_string(value)})"
        literal = f"{js_string(value)}.0" if _is_primitive(type_ref, "float") and _integral(value) else js_string(value)
        return f"{expr} {operator} {literal}"

    def _list(self, expr: str, item: str, element: str, is_map: bool, element_is_item: bool, _container) -> str:
        if is_map:
            if element_is_item:
                return f"{expr}.clone()"
            return f"{expr}.iter().map(|(key, {item})| (key.clone(), {element})).collect()"
        if element_is_item:
            return f"{expr}.iter().cloned().collect()"
        call = re.match(rf"^(\w+)::from\({item}\)$", element)
        if call:
            return f"{expr}.iter().map({call.group(1)}::from).collect()"
        return f"{expr}.iter().map(|{item}| {element}).collect()"

    def _coalesce(self, expr: str, fallback: str, type_ref: dict) -> str:
        if _is_copy(type_ref):
            return f"{expr}.unwrap_or({fallback})"
        # An optional field read from the borrowed source is cloned before taking its value
        owned = f"{expr}.clone()" if _SOURCE_FIELD.match(expr) else expr
        return f"{owned}.unwrap_or_else(|| {fallback})"

    def _null_safe(self, expr: str, build, context: dict) -> str:
        variable = context["variable"]
        inner = build(variable)
        # .as_ref() borrows the value inside; a nested optional is flattened with and_then
        is_leaf = re.match(rf"^{variable}\.\w+$", inner) and not _is_copy(context["resultType"])
        leaf = f"{inner}.clone()" if is_leaf else inner
        method = "and_then" if context["resultNullable"] else "map"
        owned = f"{expr}.as_ref()" if expr.startswith("source.") else expr
        return f"{owned}.{method}(|{variable}| {leaf})"

    def _call(self, name: str, args: list[str]) -> str:
        a = args[0] if args else None
        b = args[1] if len(args) > 1 else None
        c = args[2] if len(args) > 2 else None
        if name == "upper":
            return f"{a}.to_uppercase()"
        if name == "lower":
            return f"{a}.to_lowercase()"
        if name == "trim":
            return f"{a}.trim().to_string()"
        if name == "length":
            return f"{a}.chars().count()"
        if name == "concat":
            return f"format!({quote(''.join('{}' for _ in args))}, {', '.join(args)})"
        if name == "substring":
            if c is None:
                return f"{a}.chars().skip({b} as usize).collect::<String>()"
            return f"{a}.chars().skip({b} as usize).take({c} as usize).collect::<String>()"
        if name == "replace":
            return f"{a}.replace({b}, {c})"
        if name in ("round", "floor", "ceil", "abs"):
            return f"{a}.{name}()"
        if name in ("min", "max"):
            return f"{a}.{name}({b})"
        if name == "toString":
            return f"{a}.to_string()"
        return f'{a}.parse::<f64>().expect("not a number")'

    def _syntax(self):
        return make_syntax(
            access=lambda base, _step, name: f"{base}.{name}",
            literal=self.literal,
            convert=self.convert,
            concat=self._concat,
            split=self._split,
            boolean=self._boolean,
            enum_map=lambda expr, node, _origin: f"{self._enum_helper(node)}({_reference(expr)})",
            epoch=self._epoch,
            arithmetic=self._arithmetic,
            mapper_call=lambda mapper, expr: f"{type_name(mapper['target']['name'])}::from({_reference(expr)})",
            list=self._list,
            coalesce=self._coalesce,
            null_safe=self._null_safe,
            wrap_optional=lambda expr, _type: f"Some({expr})",
            unwrap=lambda expr, _type: f"{expr}{MISSING_MESSAGE}",
            placeholder=lambda _type, field: _placeholder(field["name"]),
            expression=make_expression_syntax(
                binary=lambda operator, left, right: (
                    f"{left}.unwrap_or({right})" if operator == "??" else f"{left} {operator} {right}"
                ),
                not_=lambda value: f"!{value}",
                conditional=lambda condition, then, otherwise: f"if {condition} {{ {then} }} else {{ {otherwise} }}",
                call=self._call,
            ),
        )

    def _owned(self, value: dict | None, code: str) -> str:
        """A direct read of a field that is not Copy is cloned: the mapping borrows its source."""
        if not value:
            return code
        if value["k"] == "path" and not value["nullable"] and not _is_copy(value["type"]):
            return f"{code}.clone()"
        if value["k"] == "path" and value["nullable"] and len(value["steps"]) == 1 and not _is_copy(value["type"]):
            return f"{code}.clone()"
        return code

    def implementation(self, mapper: dict) -> str:
        context = roots("source")
        lines: list[str] = []
        for assignment in mapper["assignments"]:
            code = self.emitter.assignment(assignment, context)
            value = assignment["value"]
            field = assignment["field"]
            optional_field = field["nullable"] or field["optional"]
            if code is not None and value and not assignment["unsafeNull"] and not assignment["missing"]:
                wrapped = code.startswith("Some(") and optional_field and not value["nullable"]
                code = f"Some({self._owned(value, code[5:-1])})" if wrapped else self._owned(value, code)
            elif code is not None and value and assignment["unsafeNull"]:
                inner = _EXPECT.sub("", code)
                code = f"{self._owned(value, inner)}{MISSING_MESSAGE}"
            # Struct literals need every field: an optional one without value is None
            if code is None:
                code = "None" if optional_field else "Default::default()"
            lines.append(f"{self.name(field, 'target')}: {code},")
        source = type_name(mapper["source"]["name"])
        target = type_name(mapper["target"]["name"])
        body = indent("\n".join(lines), 12)
        return (
            f"impl From<&{source}> for {target} {{\n    fn from(source: &{source}) -> Self {{\n"
            f"        Self {{\n{body}\n        }}\n    }}\n}}"
        )


def _generate(plan: dict, settings: dict) -> dict:
    writer = _Writer(plan, settings)
    implementations = [writer.implementation(mapper) for mapper in plan["mappers"]]
    helpers = [code for _, code in writer.helpers.values()]
    models_path = option_value(rust_generator, plan, settings, "modelsPath")
    models: set[str] = set()
    for mapper in plan["mappers"]:
        models.add(type_name(mapper["source"]["name"]))
        models.add(type_name(mapper["target"]["name"]))
    for enum_def in [*plan["enums"]["source"], *plan["enums"]["target"]]:
        models.add(type_name(enum_def["name"]))
    uses = [f"use {item};" for item in sorted(writer.uses)]
    if models_path:
        uses.append(f"use {models_path}::{{{', '.join(sorted(models))}}};")
    code = "\n\n".join(part for part in ["\n".join(uses), *implementations, *helpers] if part != "") + "\n"
    name = f"{to_snake_case(plan['root']['source']['name'])}_mapping.rs"
    return {"files": [{"name": name, "code": code}], "notes": writer.emitter.notes}


rust_generator = CodeGenerator(
    "rust", "Rust", "rust", ("from",), (GeneratorOption("modelsPath", ("crate::models",), "text"),), _generate
)
