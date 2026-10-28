"""Go mapping functions. Mirrors web/src/core/generate/languages/go.ts."""

import json
import re

from ...js import js_string
from ...model.naming import to_pascal_case
from ...model.schema import find_enum
from ..emitter import Emitter, indent, make_expression_syntax, make_syntax, quote, roots
from ..naming import NamingRules, field_name, type_name
from ..plan import all_values
from ..types import CodeGenerator, GeneratorOption, option_value

RESERVED = frozenset(
    "break case chan const continue default defer else fallthrough for func go goto if import interface map package "
    "range return select struct switch type var".split()
)

NAMING = NamingRules("go", "PascalCase", RESERVED, lambda name: f"{name}_", initialisms=True)


def _is_primitive(type_ref: dict, *names: str) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in names


def _is_number(type_ref: dict) -> bool:
    return _is_primitive(type_ref, "integer", "float", "decimal")


def _integral(value) -> bool:
    return float(value).is_integer()


# Generic helpers written into the file when the mapping needs them
HELPERS = {
    "mapSlice": """func mapSlice[T, R any](items []T, mapItem func(T) R) []R {
\tif items == nil {
\t\treturn nil
\t}
\tresult := make([]R, len(items))
\tfor index, item := range items {
\t\tresult[index] = mapItem(item)
\t}
\treturn result
}""",
    "mapValues": """func mapValues[K comparable, T, R any](items map[K]T, mapItem func(T) R) map[K]R {
\tif items == nil {
\t\treturn nil
\t}
\tresult := make(map[K]R, len(items))
\tfor key, item := range items {
\t\tresult[key] = mapItem(item)
\t}
\treturn result
}""",
    "mapPointer": """func mapPointer[T, R any](value *T, mapValue func(T) R) *R {
\tif value == nil {
\t\treturn nil
\t}
\tresult := mapValue(*value)
\treturn &result
}""",
    "valueOr": """func valueOr[T any](value *T, fallback T) T {
\tif value == nil {
\t\treturn fallback
\t}
\treturn *value
}""",
    "pointerTo": """func pointerTo[T any](value T) *T {
\treturn &value
}""",
}

_HELPER_INDENT = re.compile(r"\n(case|default|\treturn|\tpanic)")


class _Writer:
    def __init__(self, plan: dict, settings: dict):
        self.plan = plan
        self.settings = settings
        self.imports: set[str] = set()
        self.helpers: set[str] = set()
        self.enum_helpers: dict[str, tuple[str, str]] = {}
        # Types of the element closures of the list being written (set while writing each assignment)
        self.list_item_type = "any"
        self.list_result_type = "any"
        # Some conversion may fail: mappers collect errors in errs
        self.fallible = any(
            value["k"] == "convert"
            and _is_primitive(value["value"]["type"], "string", "any")
            and not _is_primitive(value["type"], "string")
            and value["type"]["kind"] != "enum"
            for value in all_values(plan)
        )
        self.emitter = Emitter(self._syntax(), lambda field, _owner, side: self.name(field, side))

    def name(self, field: dict, side: str) -> str:
        schema = self.plan["source"] if side == "source" else self.plan["target"]
        return field_name(field, schema, NAMING, self.settings["naming"])

    def go_type(self, type_ref: dict, side: str) -> str:
        """Go type of a value, for the parameters of the helper closures."""
        kind = type_ref["kind"]
        if kind == "primitive":
            name = type_ref["name"]
            bits = type_ref.get("bits")
            if name in ("string", "uuid"):
                return "string"
            if name == "integer":
                return {32: "int32", 16: "int16", 8: "int8"}.get(bits, "int64")
            if name in ("float", "decimal"):
                return "float32" if bits == 32 else "float64"
            if name == "boolean":
                return "bool"
            if name in ("datetime", "date"):
                self.imports.add("time")
                return "time.Time"
            if name == "duration":
                self.imports.add("time")
                return "time.Duration"
            if name == "binary":
                return "[]byte"
            return "any"
        if kind == "array":
            return f"[]{self.go_type(type_ref['items'], side)}"
        if kind == "map":
            return f"map[string]{self.go_type(type_ref['value'], side)}"
        if kind in ("model", "enum"):
            return type_name(type_ref["name"])
        return "any"

    def constant(self, enum_def: dict, name: str) -> str:
        # Go constants usually carry the type's name: StatusActive
        in_target = any(item is enum_def for item in self.plan["target"]["enums"])
        schema = self.plan["target"] if in_target else self.plan["source"]
        if (schema.get("origin") or {}).get("language") == "go":
            return name
        return f"{type_name(enum_def['name'])}{to_pascal_case(name)}"

    def function_name(self, mapper: dict, exported: bool) -> str:
        name = f"{type_name(mapper['source']['name'])}To{type_name(mapper['target']['name'])}"
        return f"Map{name}" if exported else f"map{name}"

    def literal(self, value, type_ref: dict) -> str:
        if value is None:
            return "nil"
        if type_ref["kind"] == "enum" and isinstance(value, str):
            enum_def = find_enum(self.plan["target"], type_ref["name"])
            if enum_def:
                return self.constant(enum_def, value)
        if isinstance(value, bool):
            return js_string(value)
        if isinstance(value, (int, float)):
            if _is_primitive(type_ref, "float", "decimal") and _integral(value):
                return f"{js_string(value)}.0"
            return js_string(value)
        return quote(value)

    def _errs(self) -> str:
        return ", errs" if self.fallible else ""

    def convert(self, expr: str, origin: dict, to: dict) -> str:
        if _is_number(origin) and _is_number(to):
            target = self.go_type(to, "target")
            return expr if self.go_type(origin, "source") == target else f"{target}({expr})"
        if _is_primitive(to, "string"):
            if _is_primitive(origin, "string", "uuid"):
                return expr
            if origin["kind"] == "enum":
                return f"string({expr})"
            if _is_primitive(origin, "datetime"):
                return f"{expr}.Format(time.RFC3339)"
            if _is_primitive(origin, "date"):
                return f"{expr}.Format(time.DateOnly)"
            self.imports.add("fmt")
            return f"fmt.Sprint({expr})"
        if _is_primitive(origin, "string"):
            target = self.go_type(to, "target")
            if _is_primitive(to, "integer"):
                return f"parseInt[{target}]({expr}{self._errs()})"
            if _is_primitive(to, "float", "decimal"):
                return f"parseFloat[{target}]({expr}{self._errs()})"
            if _is_primitive(to, "datetime"):
                return f"parseTime({expr}, time.RFC3339{self._errs()})"
            if _is_primitive(to, "date"):
                return f"parseTime({expr}, time.DateOnly{self._errs()})"
            if to["kind"] == "enum":
                return f"{type_name(to['name'])}({expr})"
        if _is_primitive(origin, "date") and _is_primitive(to, "datetime"):
            return expr
        if _is_primitive(origin, "datetime") and _is_primitive(to, "date"):
            return f"{expr}.Truncate(24 * time.Hour)"
        return expr

    def _enum_helper(self, node: dict) -> str:
        source = node.get("source")
        target = type_name(node["target"]["name"])
        base = f"to{target}"
        key = json.dumps([node["pairs"], node.get("fallback"), source["name"] if source else None])
        name = base
        n = 2
        while name in self.enum_helpers and self.enum_helpers[name][0] != key:
            name = f"{base}{n}"
            n += 1
        if name not in self.enum_helpers:
            cases = [
                f"case {self.constant(source, pair['from']) if source else quote(pair['from'])}:"
                f"\n\treturn {self.constant(node['target'], pair['to'])}"
                for pair in node["pairs"]
            ]
            if "fallback" in node:
                fallback = f"default:\n\treturn {self.constant(node['target'], node['fallback'])}"
            else:
                self.imports.add("fmt")
                described = source["name"] if source else "value"
                fallback = f'default:\n\tpanic(fmt.Sprintf("unexpected {described}: %v", value))'
            parameter = type_name(source["name"]) if source else "string"
            body = "\n".join([*cases, fallback])
            code = f"func {name}(value {parameter}) {target} {{\n\tswitch value {{\n{body}\n\t}}\n}}"
            self.enum_helpers[name] = (key, _HELPER_INDENT.sub(lambda match: f"\n\t{match.group(1)}", code))
        return name

    def _split(self, expr: str, separator: str, part) -> str:
        self.imports.add("strings")
        sep = quote(separator)
        if part == 0:
            return f"strings.SplitN({expr}, {sep}, 2)[0]"
        if part == "last":
            return f"{expr}[strings.LastIndex({expr}, {sep})+{len(separator)}:]"
        if part == "rest":
            return f"strings.TrimPrefix(strings.TrimPrefix({expr}, strings.SplitN({expr}, {sep}, 2)[0]), {sep})"
        return f"strings.Split({expr}, {sep})[{part}]"

    def _boolean(self, expr: str, true_values: list, origin: dict) -> str:
        enum_def = find_enum(self.plan["source"], origin["name"]) if origin["kind"] == "enum" else None
        return " || ".join(
            f"{expr} == {self.constant(enum_def, value) if enum_def else quote(value)}" for value in true_values
        )

    def _epoch(self, expr: str, unit: str, to_date: bool, origin: dict, _to: dict) -> str:
        self.imports.add("time")
        if to_date:
            whole = f"int64({expr})" if _is_primitive(origin, "float") else expr
            return f"time.Unix({whole}, 0).UTC()" if unit == "seconds" else f"time.UnixMilli({whole}).UTC()"
        return f"{expr}.Unix()" if unit == "seconds" else f"{expr}.UnixMilli()"

    def _arithmetic(self, expr: str, operator: str, value, type_ref: dict) -> str:
        literal = (
            f"{js_string(value)}.0"
            if _is_primitive(type_ref, "float", "decimal") and _integral(value)
            else js_string(value)
        )
        return f"{expr} {operator} {literal}"

    def _list(self, expr: str, item: str, element: str, is_map: bool, element_is_item: bool, _container) -> str:
        helper = "mapValues" if is_map else "mapSlice"
        if element_is_item:
            return expr
        self.helpers.add(helper)
        call = re.match(rf"^(\w+)\({item}{', errs' if self.fallible else ''}\)$", element)
        if call and not self.fallible:
            return f"{helper}({expr}, {call.group(1)})"
        return (
            f"{helper}({expr}, func({item} {self.list_item_type}) {self.list_result_type} {{\n\treturn {element}\n}})"
        )

    def _coalesce(self, expr: str, fallback: str, _type: dict) -> str:
        self.helpers.add("valueOr")
        return f"valueOr({expr}, {fallback})"

    def _null_safe(self, expr: str, build, context: dict) -> str:
        self.helpers.add("mapPointer")
        result = self.go_type(context["resultType"], "target")
        if context["resultNullable"]:
            result = f"*{result}"
        parameter = self.go_type(context["type"], "source")
        variable = context["variable"]
        return f"mapPointer({expr}, func({variable} {parameter}) {result} {{\n\treturn {build(variable)}\n}})"

    def _wrap_optional(self, expr: str, type_ref: dict) -> str:
        # A nullable Go field is a pointer: a present value is passed by address
        if type_ref["kind"] in ("array", "map"):
            return expr
        self.helpers.add("pointerTo")
        return f"pointerTo({expr})"

    def _binary(self, operator: str, left: str, right: str) -> str:
        if operator == "??":
            self.helpers.add("valueOr")
            return f"valueOr({left}, {right})"
        return f"{left} {operator} {right}"

    def _call(self, name: str, args: list[str]) -> str:
        a = args[0] if args else None
        b = args[1] if len(args) > 1 else None
        c = args[2] if len(args) > 2 else None
        functions = {"upper": "ToUpper", "lower": "ToLower", "trim": "TrimSpace"}
        if name in functions:
            self.imports.add("strings")
            return f"strings.{functions[name]}({a})"
        if name == "length":
            return f"len([]rune({a}))"
        if name == "concat":
            self.imports.add("fmt")
            return f"fmt.Sprint({', '.join(args)})"
        if name == "substring":
            return f"string([]rune({a})[{b}:])" if c is None else f"string([]rune({a})[{b}:{b}+{c}])"
        if name == "replace":
            self.imports.add("strings")
            return f"strings.ReplaceAll({a}, {b}, {c})"
        if name in ("round", "floor", "ceil", "abs"):
            self.imports.add("math")
            return f"math.{name[:1].upper()}{name[1:]}({a})"
        if name in ("min", "max"):
            return f"{name}({a}, {b})"
        if name == "toString":
            self.imports.add("fmt")
            return f"fmt.Sprint({a})"
        return f"parseFloat[float64]({a}{self._errs()})"

    def _syntax(self):
        return make_syntax(
            access=lambda base, _step, name: f"{base}.{name}",
            literal=self.literal,
            convert=self.convert,
            concat=lambda parts, separator: f" + {quote(separator)} + ".join(parts),
            split=self._split,
            boolean=self._boolean,
            enum_map=lambda expr, node, _origin: f"{self._enum_helper(node)}({expr})",
            epoch=self._epoch,
            arithmetic=self._arithmetic,
            mapper_call=lambda mapper, expr: f"{self.function_name(mapper, False)}({expr}{self._errs()})",
            list=self._list,
            coalesce=self._coalesce,
            null_safe=self._null_safe,
            wrap_optional=self._wrap_optional,
            unwrap=lambda expr, _type: f"*{expr}",
            placeholder=lambda type_ref, _field: self.placeholder(type_ref),
            expression=make_expression_syntax(
                binary=self._binary,
                not_=lambda value: f"!{value}",
                conditional=lambda condition, then, otherwise: (
                    f"func() any {{\n\tif {condition} {{\n\t\treturn {then}\n\t}}\n\treturn {otherwise}\n}}()"
                ),
                call=self._call,
            ),
        )

    def placeholder(self, type_ref: dict) -> str:
        if type_ref["kind"] == "primitive":
            if _is_primitive(type_ref, "string", "uuid"):
                return '""'
            if _is_number(type_ref):
                return "0"
            if _is_primitive(type_ref, "boolean"):
                return "false"
        return f"*new({self.go_type(type_ref, 'target')})"

    def _prepare_list(self, value: dict | None) -> None:
        """The element types of a list value, for its closure's signature."""
        node = value
        found = None
        while node is not None:
            if node["k"] == "list":
                found = node
                break
            inner = node.get("value")
            node = inner if isinstance(inner, dict) and "k" in inner else None
        if not found:
            return

        def items(type_ref: dict) -> dict:
            if type_ref["kind"] == "array":
                return type_ref["items"]
            if type_ref["kind"] == "map":
                return type_ref["value"]
            return type_ref

        self.list_item_type = self.go_type(items(found["value"]["type"]), "source")
        self.list_result_type = self.go_type(items(found["type"]), "target")

    def mapper_function(self, mapper: dict) -> str:
        context = roots("source")
        lines: list[str] = []
        for assignment in mapper["assignments"]:
            self._prepare_list(assignment["value"])
            code = self.emitter.assignment(assignment, context)
            if code is None:
                continue
            name = assignment["field"]["name"]
            if assignment["missing"]:
                lines.append(f'// TODO: no value for "{name}" in the mapping')
            elif assignment["unsafeNull"]:
                lines.append(f'// "{name}" is required: panics if the source is missing')
            lines.append(f"{self.name(assignment['field'], 'target')}: {code},")
        target = type_name(mapper["target"]["name"])
        body = f"{target}{{\n{indent(chr(10).join(lines), 2)}\n}}" if lines else f"{target}{{}}"
        parameters = f"source {type_name(mapper['source']['name'])}{', errs *[]error' if self.fallible else ''}"
        returned = body.replace("\n", "\n\t")
        code = f"func {self.function_name(mapper, False)}({parameters}) {target} {{\n\treturn {returned}\n}}"
        return code.replace("  ", "\t")

    def entry_point(self) -> str:
        """The exported entry point: returns the errors of the conversions that failed."""
        root = self.plan["root"]
        source = type_name(root["source"]["name"])
        target = type_name(root["target"]["name"])
        name = self.function_name(root, True)
        inner = self.function_name(root, False)
        if not self.fallible:
            return (
                f"// {name} maps a {source} to a {target}.\n"
                f"func {name}(source {source}) {target} {{\n\treturn {inner}(source)\n}}"
            )
        self.imports.add("errors")
        return (
            f"// {name} maps a {source} to a {target}. The error lists every value that could not be converted.\n"
            f"func {name}(source {source}) ({target}, error) {{\n\tvar errs []error\n"
            f"\ttarget := {inner}(source, &errs)\n"
            "\treturn target, errors.Join(errs...)\n}"
        )

    def parse_helpers(self, code: str) -> list[str]:
        helpers: list[str] = []
        errs = self.fallible
        parameter = ", errs *[]error" if errs else ""
        failure = "*errs = append(*errs, err)" if errs else "panic(err)"
        check = f"\tif err != nil {{\n\t\t{failure}\n\t}}\n"
        if "parseInt[" in code:
            self.imports.add("strconv")
            helpers.append(
                f"func parseInt[T int8 | int16 | int32 | int64](text string{parameter}) T {{\n"
                f"\tvalue, err := strconv.ParseInt(text, 10, 64)\n{check}\treturn T(value)\n}}"
            )
        if "parseFloat[" in code:
            self.imports.add("strconv")
            helpers.append(
                f"func parseFloat[T float32 | float64](text string{parameter}) T {{\n"
                f"\tvalue, err := strconv.ParseFloat(text, 64)\n{check}\treturn T(value)\n}}"
            )
        if "parseTime(" in code:
            self.imports.add("time")
            helpers.append(
                f"func parseTime(text, layout string{parameter}) time.Time {{\n"
                f"\tvalue, err := time.Parse(layout, text)\n{check}\treturn value\n}}"
            )
        return helpers


def _generate(plan: dict, settings: dict) -> dict:
    writer = _Writer(plan, settings)
    functions = [writer.mapper_function(mapper) for mapper in plan["mappers"]]
    entry = writer.entry_point()
    enum_helpers = [code for _, code in writer.enum_helpers.values()]
    body = "\n\n".join([entry, *functions, *enum_helpers])
    parse = writer.parse_helpers(body)
    generic = [HELPERS[name] for name in sorted(writer.helpers)]
    pkg = option_value(go_generator, plan, settings, "package") or "mapping"
    imports = sorted(writer.imports)
    if not imports:
        import_block = ""
    elif len(imports) == 1:
        import_block = f"import {quote(imports[0])}"
    else:
        import_block = "import (\n" + "\n".join(f"\t{quote(item)}" for item in imports) + "\n)"
    code = "\n\n".join(part for part in [f"package {pkg}", import_block, body, *parse, *generic] if part != "") + "\n"
    return {"files": [{"name": "mapping.go", "code": code}], "notes": writer.emitter.notes}


def _defaults(plan: dict) -> dict:
    namespace = plan["root"]["target"].get("namespace")
    if (plan["target"].get("origin") or {}).get("language") == "go" and namespace:
        return {"package": namespace}
    return {}


go_generator = CodeGenerator(
    "go", "Go", "go", ("functions",), (GeneratorOption("package", ("mapping",), "text"),), _generate, _defaults
)
