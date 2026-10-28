"""Swift extensions. Mirrors web/src/core/generate/languages/swift.ts."""

import json
import re

from ...js import js_string
from ...model.naming import to_camel_case
from ...model.schema import find_enum
from ..emitter import Emitter, indent, make_expression_syntax, make_syntax, quote, roots
from ..naming import NamingRules, field_name, is_valid_identifier, type_name
from ..types import CodeGenerator

RESERVED = frozenset(
    "associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private "
    "protocol public rethrows static struct subscript typealias var break case continue default defer do else "
    "fallthrough for guard if in repeat return switch where while as catch false is nil self super throw throws true "
    "try".split()
)

NAMING = NamingRules("swift", "camelCase", RESERVED, lambda name: f"`{name}`")


def _is_primitive(type_ref: dict, *names: str) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in names


def _is_number(type_ref: dict) -> bool:
    return _is_primitive(type_ref, "integer", "float", "decimal")


_SIMPLE = re.compile(r'^[\w.()"!?]+$')
_SPECIAL = re.compile(r'[\\"]')


def operand(code: str) -> str:
    return code if _SIMPLE.match(code) and " " not in code else f"({code})"


def _interpolate(parts: list[str], separator: str) -> str:
    """Swift string interpolation: "\\(first) \\(last)"."""
    escaped = _SPECIAL.sub(lambda match: f"\\{match.group(0)}", separator)
    return '"' + escaped.join(f"\\({part})" for part in parts) + '"'


def _int_type(type_ref: dict) -> str:
    """The Swift name of an integer type: Int unless a size is known."""
    bits = type_ref.get("bits") if type_ref["kind"] == "primitive" else None
    return f"Int{bits}" if bits and bits != 64 else "Int"


def _integral(value) -> bool:
    return float(value).is_integer()


class _Writer:
    def __init__(self, plan: dict, settings: dict):
        self.plan = plan
        self.settings = settings
        self.helpers: dict[str, tuple[str, str]] = {}
        self.emitter = Emitter(self._syntax(), lambda field, _owner, side: self.name(field, side))

    def name(self, field: dict, side: str) -> str:
        schema = self.plan["source"] if side == "source" else self.plan["target"]
        return field_name(field, schema, NAMING, self.settings["naming"])

    def enum_case(self, _enum_def: dict, name: str, side: str) -> str:
        """A case written as .name: Swift infers the enum from the context."""
        schema = self.plan["source"] if side == "source" else self.plan["target"]
        is_swift = (schema.get("origin") or {}).get("language") == "swift"
        member = name if is_swift and is_valid_identifier(name) else to_camel_case(name) or "value"
        return f".{f'`{member}`' if member in RESERVED else member}"

    def function_name(self, mapper: dict) -> str:
        return f"to{type_name(mapper['target']['name'])}"

    def literal(self, value, type_ref: dict) -> str:
        if value is None:
            return "nil"
        if type_ref["kind"] == "enum" and isinstance(value, str):
            enum_def = find_enum(self.plan["target"], type_ref["name"])
            if enum_def:
                return self.enum_case(enum_def, value, "target")
        if isinstance(value, bool):
            return js_string(value)
        if isinstance(value, (int, float)):
            return (
                f"{js_string(value)}.0" if _is_primitive(type_ref, "float") and _integral(value) else js_string(value)
            )
        if _is_primitive(type_ref, "datetime", "date"):
            return f"ISO8601DateFormatter().date(from: {quote(value)})!"
        return quote(value)

    def convert(self, expr: str, origin: dict, to: dict) -> str:
        if _is_number(origin) and _is_number(to):
            if _is_primitive(to, "decimal"):
                return expr if _is_primitive(origin, "decimal") else f"Decimal({expr})"
            if _is_primitive(to, "float"):
                if _is_primitive(origin, "decimal"):
                    return f"NSDecimalNumber(decimal: {expr}).doubleValue"
                return expr if _is_primitive(origin, "float") else f"Double({expr})"
            if _is_primitive(origin, "decimal"):
                return f"NSDecimalNumber(decimal: {expr}).intValue"
            if _int_type(origin) == _int_type(to) and not _is_primitive(origin, "float"):
                return expr
            return f"{_int_type(to)}({expr})"
        if _is_primitive(to, "string"):
            if _is_primitive(origin, "string"):
                return expr
            if origin["kind"] == "enum":
                return f"{operand(expr)}.rawValue"
            if _is_primitive(origin, "uuid"):
                return f"{operand(expr)}.uuidString"
            if _is_primitive(origin, "datetime", "date"):
                return f"ISO8601DateFormatter().string(from: {expr})"
            return f"String(describing: {expr})"
        if _is_primitive(origin, "string"):
            # Text that does not parse stops the program: the validation already warned about it
            if _is_primitive(to, "integer"):
                return f"{_int_type(to)}({expr})!"
            if _is_primitive(to, "float"):
                return f"Double({expr})!"
            if _is_primitive(to, "decimal"):
                return f"Decimal(string: {expr})!"
            if _is_primitive(to, "datetime", "date"):
                return f"ISO8601DateFormatter().date(from: {expr})!"
            if _is_primitive(to, "uuid"):
                return f"UUID(uuidString: {expr})!"
            if to["kind"] == "enum":
                return f"{type_name(to['name'])}(rawValue: {expr})!"
        if _is_primitive(origin, "boolean") and _is_primitive(to, "integer"):
            return f"{expr} ? 1 : 0"
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
            cases = [
                f"case {self.enum_case(source, pair['from'], 'source') if source else quote(pair['from'])}:"
                f" return {self.enum_case(node['target'], pair['to'], 'target')}"
                for pair in node["pairs"]
            ]
            complete = source is not None and len(node["pairs"]) >= len(source["values"])
            if "fallback" in node:
                cases.append(f"default: return {self.enum_case(node['target'], node['fallback'], 'target')}")
            elif not complete:
                described = source["name"] if source else "value"
                cases.append(f'default: fatalError("Unexpected {described}: \\(value)")')
            parameter = type_name(source["name"]) if source else "String"
            body = indent("\n".join(cases), 4)
            code = f"private func {name}(_ value: {parameter}) -> {target} {{\n    switch value {{\n{body}\n    }}\n}}"
            self.helpers[name] = (key, code)
        return name

    def _split(self, expr: str, separator: str, part) -> str:
        split = f"{operand(expr)}.components(separatedBy: {quote(separator)})"
        if part == 0:
            return f'{split}.first ?? ""'
        if part == "last":
            return f'{split}.last ?? ""'
        if part == "rest":
            return f"{split}.dropFirst().joined(separator: {quote(separator)})"
        return f'({split}.count > {part} ? {split}[{part}] : "")'

    def _boolean(self, expr: str, true_values: list, origin: dict) -> str:
        enum_def = find_enum(self.plan["source"], origin["name"]) if origin["kind"] == "enum" else None
        if enum_def:
            return " || ".join(f"{expr} == {self.enum_case(enum_def, value, 'source')}" for value in true_values)
        if len(true_values) == 1:
            return f"{expr} == {quote(true_values[0])}"
        return f"[{', '.join(quote(value) for value in true_values)}].contains({expr})"

    def _epoch(self, expr: str, unit: str, to_date: bool, _origin: dict, _to: dict) -> str:
        if to_date:
            interval = f"TimeInterval({expr})" if unit == "seconds" else f"TimeInterval({expr}) / 1000"
            return f"Date(timeIntervalSince1970: {interval})"
        if unit == "seconds":
            return f"Int({operand(expr)}.timeIntervalSince1970)"
        return f"Int({operand(expr)}.timeIntervalSince1970 * 1000)"

    def _arithmetic(self, expr: str, operator: str, value, type_ref: dict) -> str:
        literal = f"{js_string(value)}.0" if _is_primitive(type_ref, "float") and _integral(value) else js_string(value)
        return f"{operand(expr)} {operator} {literal}"

    def _list(self, expr: str, item: str, element: str, is_map: bool, element_is_item: bool, container) -> str:
        is_set = (container or "").endswith("Set")
        if is_map:
            return expr if element_is_item else f"{operand(expr)}.mapValues {{ {item} in {element} }}"
        if element_is_item:
            return f"Set({expr})" if is_set else f"Array({expr})"
        call = re.match(rf"^{item}\.(\w+)\(\)$", element)
        mapped = (
            f"{operand(expr)}.map {{ $0.{call.group(1)}() }}"
            if call
            else f"{operand(expr)}.map {{ {item} in {element} }}"
        )
        return f"Set({mapped})" if is_set else mapped

    def _null_safe(self, expr: str, build, context: dict) -> str:
        marker = "\u0000"
        built = build(marker)
        if built.startswith(f"{marker}.") and marker not in built[1:]:
            return f"{operand(expr)}?{built[1:]}"
        return f"{operand(expr)}.map {{ {context['variable']} in {build(context['variable'])} }}"

    def _call(self, name: str, args: list[str]) -> str:
        a = args[0] if args else None
        b = args[1] if len(args) > 1 else None
        c = args[2] if len(args) > 2 else None
        if name == "upper":
            return f"{operand(a)}.uppercased()"
        if name == "lower":
            return f"{operand(a)}.lowercased()"
        if name == "trim":
            return f"{operand(a)}.trimmingCharacters(in: .whitespaces)"
        if name == "length":
            return f"{operand(a)}.count"
        if name == "concat":
            return _interpolate(args, "")
        if name == "substring":
            if c is None:
                return f"String({operand(a)}.dropFirst({b}))"
            return f"String({operand(a)}.dropFirst({b}).prefix({c}))"
        if name == "replace":
            return f"{operand(a)}.replacingOccurrences(of: {b}, with: {c})"
        if name in ("round", "floor", "ceil", "abs"):
            return f"{name}({a})"
        if name in ("min", "max"):
            return f"{name}({a}, {b})"
        if name == "toString":
            return f"String(describing: {a})"
        return f"Double({a})!"

    def _syntax(self):
        return make_syntax(
            access=lambda base, _step, name: name if base == "self" else f"{base}.{name}",
            safe_access=lambda base, _step, name: f"{base}?.{name}",
            literal=self.literal,
            convert=self.convert,
            concat=_interpolate,
            split=self._split,
            boolean=self._boolean,
            enum_map=lambda expr, node, _origin: f"{self._enum_helper(node)}({expr})",
            epoch=self._epoch,
            arithmetic=self._arithmetic,
            mapper_call=lambda mapper, expr: (
                f"{self.function_name(mapper)}()"
                if expr == "self"
                else f"{operand(expr)}.{self.function_name(mapper)}()"
            ),
            list=self._list,
            coalesce=lambda expr, fallback, _type: f"{expr} ?? {fallback}",
            null_safe=self._null_safe,
            unwrap=lambda expr, _type: f"{operand(expr)}!",
            placeholder=lambda _type, field: f'fatalError("No value for {field["name"]} in the mapping")',
            expression=make_expression_syntax(
                binary=lambda operator, left, right: f"{left} {operator} {right}",
                not_=lambda value: f"!{operand(value)}",
                conditional=lambda condition, then, otherwise: f"{condition} ? {then} : {otherwise}",
                call=self._call,
            ),
        )

    def extension(self, mapper: dict) -> str:
        context = roots("self")
        target = type_name(mapper["target"]["name"])
        lines: list[str] = []
        for assignment in mapper["assignments"]:
            code = self.emitter.assignment(assignment, context)
            # The memberwise initializer takes every stored property: optional ones get nil
            if code is None:
                if "defaultValue" in assignment["field"]:
                    continue
                code = "nil"
            lines.append(f"{self.name(assignment['field'], 'target')}: {code},")
        if lines:
            lines[-1] = re.sub(r",$", "", lines[-1])
        body = f"{target}(\n{indent(chr(10).join(lines), 12)}\n        )" if lines else f"{target}()"
        return (
            f"extension {type_name(mapper['source']['name'])} {{\n"
            f"    func {self.function_name(mapper)}() -> {target} {{\n        {body}\n    }}\n}}"
        )


def _generate(plan: dict, settings: dict) -> dict:
    writer = _Writer(plan, settings)
    extensions = [writer.extension(mapper) for mapper in plan["mappers"]]
    helpers = [code for _, code in writer.helpers.values()]
    code = "\n\n".join(["import Foundation", *extensions, *helpers]) + "\n"
    name = f"{type_name(plan['root']['source']['name'])}+Mapping.swift"
    return {"files": [{"name": name, "code": code}], "notes": writer.emitter.notes}


swift_generator = CodeGenerator("swift", "Swift", "swift", ("extensions",), (), _generate)
