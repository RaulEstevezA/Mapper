"""C# mappers: extension methods, or an AutoMapper profile. Mirrors web/src/core/generate/languages/csharp.ts."""

import json
import re

from ...js import js_string
from ...model.naming import to_pascal_case
from ...model.schema import find_enum
from ..emitter import Emitter, indent, make_expression_syntax, make_syntax, quote, roots
from ..naming import NamingRules, field_name, is_valid_identifier, type_name
from ..types import CodeGenerator, GeneratorOption, option_value

RESERVED = frozenset(
    "abstract as base bool break byte case catch char checked class const continue decimal default delegate do "
    "double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface "
    "internal is lock long namespace new null object operator out override params private protected public readonly "
    "ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint "
    "ulong unchecked unsafe ushort using virtual void volatile while".split()
)

NAMING = NamingRules("csharp", "PascalCase", RESERVED, lambda name: f"@{name}")


def _is_number(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("integer", "float", "decimal")


def _is_primitive(type_ref: dict, *names: str) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in names


_SIMPLE = re.compile(r'^[\w.()"?\[\]]+$')


def operand(code: str) -> str:
    return code if _SIMPLE.match(code) and " " not in code else f"({code})"


def _date_time_type(schema: dict) -> str:
    """DateTime or DateTimeOffset: the one the C# models declare, DateTime otherwise."""
    if (schema.get("origin") or {}).get("language") == "csharp":
        for model in schema["models"]:
            for field in model["fields"]:
                if _is_primitive(field["type"], "datetime") and (field.get("originalType") or "").startswith(
                    "DateTimeOffset"
                ):
                    return "DateTimeOffset"
    return "DateTime"


def _integral(value) -> bool:
    return float(value).is_integer()


_LOWER_START = re.compile(r"^[a-z]")
_SPECIAL = re.compile(r'["{}\\]')
_BRACES = re.compile(r"[{}]")
_MARKER = "\u0000"


class _Writer:
    def __init__(self, plan: dict, settings: dict, expression_tree: bool = False):
        self.plan = plan
        self.settings = settings
        # AutoMapper expressions are expression trees: no ?., no patterns, no throw
        self.expression_tree = expression_tree
        self.usings: dict[str, None] = {}
        self.helpers: dict[str, tuple[str, str]] = {}
        self.source_date_time = _date_time_type(plan["source"])
        self.target_date_time = _date_time_type(plan["target"])
        self.emitter = Emitter(self._syntax(), lambda field, _owner, side: self.name(field, side))

    def name(self, field: dict, side: str) -> str:
        schema = self.plan["source"] if side == "source" else self.plan["target"]
        return field_name(field, schema, NAMING, self.settings["naming"])

    def enum_member(self, enum_def: dict, name: str) -> str:
        keep = is_valid_identifier(name) and not (enum_def.get("kind") == "literals" and _LOWER_START.match(name))
        return f"{type_name(enum_def['name'])}.{name if keep else to_pascal_case(name) or 'Value'}"

    def method_name(self, mapper: dict) -> str:
        return f"To{type_name(mapper['target']['name'])}"

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
                return f"{js_string(value)}m"
            if _is_primitive(type_ref, "float"):
                return f"{js_string(value)}.0" if _integral(value) else js_string(value)
            if _is_primitive(type_ref, "integer") and type_ref.get("bits") == 64:
                return f"{js_string(value)}L"
            return js_string(value)
        if _is_primitive(type_ref, "datetime"):
            self.usings["System.Globalization"] = None
            return f"{self.target_date_time}.Parse({quote(value)}, CultureInfo.InvariantCulture)"
        return quote(value)

    def _invariant(self) -> str:
        self.usings["System.Globalization"] = None
        return "CultureInfo.InvariantCulture"

    def convert(self, expr: str, origin: dict, to: dict) -> str:
        if _is_number(origin) and _is_number(to):
            if to["name"] == "decimal":
                return expr if origin["name"] == "decimal" else f"(decimal){operand(expr)}"
            if to["name"] == "float":
                return expr if origin["name"] == "float" else f"(double){operand(expr)}"
            if origin["name"] != "integer":
                return f"(int){operand(expr)}" if to.get("bits") == 32 else f"(long){operand(expr)}"
            if to.get("bits") == 32 and origin.get("bits") != 32:
                return f"checked((int){operand(expr)})"
            return expr
        if _is_primitive(to, "string"):
            if _is_primitive(origin, "string"):
                return expr
            if _is_primitive(origin, "datetime", "date", "time"):
                return f'{operand(expr)}.ToString("O", {self._invariant()})'
            if _is_number(origin):
                return f"{operand(expr)}.ToString({self._invariant()})"
            return f"{operand(expr)}.ToString()"
        if _is_primitive(origin, "string", "any"):
            text = f"{operand(expr)}.ToString()!" if _is_primitive(origin, "any") else expr
            if to["kind"] == "primitive":
                name = to["name"]
                if name == "integer":
                    return f"{'int' if to.get('bits') == 32 else 'long'}.Parse({text}, {self._invariant()})"
                if name == "float":
                    return f"double.Parse({text}, {self._invariant()})"
                if name == "decimal":
                    return f"decimal.Parse({text}, {self._invariant()})"
                if name == "datetime":
                    return f"{self.target_date_time}.Parse({text}, {self._invariant()})"
                if name == "date":
                    return f"DateOnly.Parse({text}, {self._invariant()})"
                if name == "time":
                    return f"TimeOnly.Parse({text}, {self._invariant()})"
                if name == "duration":
                    return f"TimeSpan.Parse({text}, {self._invariant()})"
                if name == "uuid":
                    return f"Guid.Parse({text})"
            if to["kind"] == "enum":
                return f"Enum.Parse<{type_name(to['name'])}>({text})"
        if _is_primitive(origin, "date") and _is_primitive(to, "datetime"):
            return f"{operand(expr)}.ToDateTime(TimeOnly.MinValue)"
        if _is_primitive(origin, "datetime") and _is_primitive(to, "date"):
            value = f"{operand(expr)}.UtcDateTime" if self.source_date_time == "DateTimeOffset" else expr
            return f"DateOnly.FromDateTime({value})"
        if (
            _is_primitive(origin, "datetime")
            and _is_primitive(to, "datetime")
            and self.source_date_time != self.target_date_time
        ):
            return (
                f"{operand(expr)}.UtcDateTime" if self.target_date_time == "DateTime" else f"new DateTimeOffset({expr})"
            )
        if _is_primitive(origin, "boolean") and _is_primitive(to, "integer"):
            return f"{operand(expr)} ? 1 : 0"
        return expr

    def _enum_helper(self, node: dict) -> str:
        source = node.get("source")
        target = type_name(node["target"]["name"])
        base = f"To{target}"
        key = json.dumps([node["pairs"], node.get("fallback"), source["name"] if source else None])
        name = base
        n = 2
        while name in self.helpers and self.helpers[name][0] != key:
            name = f"{base}{n}"
            n += 1
        if name not in self.helpers:
            arms = [
                f"{self.enum_member(source, pair['from']) if source else quote(pair['from'])}"
                f" => {self.enum_member(node['target'], pair['to'])},"
                for pair in node["pairs"]
            ]
            if "fallback" in node:
                arms.append(f"_ => {self.enum_member(node['target'], node['fallback'])},")
            else:
                arms.append("_ => throw new ArgumentOutOfRangeException(nameof(value), value, null),")
            parameter = type_name(source["name"]) if source else "string"
            code = (
                f"    private static {target} {name}({parameter} value) => value switch\n"
                f"    {{\n{indent(chr(10).join(arms), 8)}\n    }};"
            )
            self.helpers[name] = (key, code)
        return name

    def _concat(self, parts: list[str], separator: str) -> str:
        if all(not _SPECIAL.search(part) for part in parts):
            doubled = _BRACES.sub(lambda match: match.group(0) * 2, separator)
            return f"${quote(doubled.join(f'{{{part}}}' for part in parts))}"
        joined = []
        for index, part in enumerate(parts):
            if index > 0:
                joined.append(quote(separator))
            joined.append(part)
        return f"string.Concat({', '.join(joined)})"

    def _split(self, expr: str, separator: str, part) -> str:
        sep = quote(separator)
        if part == 0:
            return f"{operand(expr)}.Split({sep})[0]"
        if part == "last":
            return f"{operand(expr)}.Split({sep})[^1]"
        if part == "rest":
            index = f"{operand(expr)}.IndexOf({sep}, StringComparison.Ordinal) + {len(separator)}"
            return f'{operand(expr)}.Contains({sep}) ? {operand(expr)}[({index})..] : ""'
        return f"{operand(expr)}.Split({sep})[{part}]"

    def _boolean(self, expr: str, true_values: list, origin: dict) -> str:
        enum_def = find_enum(self.plan["source"], origin["name"]) if origin["kind"] == "enum" else None
        values = [self.enum_member(enum_def, value) if enum_def else quote(value) for value in true_values]
        if len(values) == 1 or self.expression_tree:
            return " || ".join(f"{expr} == {value}" for value in values)
        return f"{expr} is {' or '.join(values)}"

    def _epoch(self, expr: str, unit: str, to_date: bool, origin: dict, _to: dict) -> str:
        suffix = "Seconds" if unit == "seconds" else "Milliseconds"
        if to_date:
            whole = f"(long){operand(expr)}" if _is_primitive(origin, "float") else expr
            offset = f"DateTimeOffset.FromUnixTime{suffix}({whole})"
            return f"{offset}.UtcDateTime" if self.target_date_time == "DateTime" else offset
        offset = f"new DateTimeOffset({expr})" if self.source_date_time == "DateTime" else expr
        return f"{operand(offset)}.ToUnixTime{suffix}()"

    def _arithmetic(self, expr: str, operator: str, value, type_ref: dict) -> str:
        if _is_primitive(type_ref, "decimal"):
            literal = f"{js_string(value)}m"
        elif _is_primitive(type_ref, "float") and _integral(value):
            literal = f"{js_string(value)}.0"
        else:
            literal = js_string(value)
        return f"{operand(expr)} {operator} {literal}"

    def _list(self, expr: str, item: str, element: str, is_map: bool, element_is_item: bool, container) -> str:
        self.usings["System.Linq"] = None
        if is_map:
            value = "entry.Value" if element_is_item else element.replace(item, "entry.Value")
            return f"{operand(expr)}.ToDictionary(entry => entry.Key, entry => {value})"
        if (container or "").endswith("Set"):
            collect = "ToHashSet()"
        elif container is not None and (container.endswith("[]") or container == ""):
            collect = "ToArray()"
        else:
            collect = "ToList()"
        return (
            f"{operand(expr)}.{collect}"
            if element_is_item
            else f"{operand(expr)}.Select({item} => {element}).{collect}"
        )

    def _null_safe(self, expr: str, build, context: dict) -> str:
        if self.expression_tree:
            return build(expr)
        # A call or member read on the value: x?.ToAddress()
        built = build(_MARKER)
        if built.startswith(f"{_MARKER}.") and _MARKER not in built[1:]:
            return f"{operand(expr)}?{built[1:]}"
        return f"{operand(expr)} is {{ }} {context['variable']} ? {build(context['variable'])} : null"

    def _unwrap(self, expr: str, _type: dict) -> str:
        if self.expression_tree:
            return expr
        return f'{expr} ?? throw new InvalidOperationException("A required value is missing in the source.")'

    def _call(self, name: str, args: list[str]) -> str:
        a = args[0] if args else None
        b = args[1] if len(args) > 1 else None
        c = args[2] if len(args) > 2 else None
        if name == "upper":
            return f"{operand(a)}.ToUpperInvariant()"
        if name == "lower":
            return f"{operand(a)}.ToLowerInvariant()"
        if name == "trim":
            return f"{operand(a)}.Trim()"
        if name == "length":
            return f"{operand(a)}.Length"
        if name == "concat":
            return f"string.Concat({', '.join(args)})"
        if name == "substring":
            return f"{operand(a)}.Substring({b})" if c is None else f"{operand(a)}.Substring({b}, {c})"
        if name == "replace":
            return f"{operand(a)}.Replace({b}, {c})"
        if name in ("round", "floor", "abs", "min", "max"):
            return f"Math.{name[:1].upper()}{name[1:]}({', '.join(args)})"
        if name == "ceil":
            return f"Math.Ceiling({a})"
        if name == "toString":
            return f"{operand(a)}.ToString()"
        return f"double.Parse({a}, {self._invariant()})"

    def _syntax(self):
        return make_syntax(
            access=lambda base, _step, name: f"{base}.{name}",
            safe_access=None if self.expression_tree else (lambda base, _step, name: f"{base}?.{name}"),
            literal=self.literal,
            convert=self.convert,
            concat=self._concat,
            split=self._split,
            boolean=self._boolean,
            enum_map=lambda expr, node, _origin: f"{self._enum_helper(node)}({expr})",
            epoch=self._epoch,
            arithmetic=self._arithmetic,
            mapper_call=lambda mapper, expr: f"{operand(expr)}.{self.method_name(mapper)}()",
            list=self._list,
            coalesce=lambda expr, fallback, _type: f"{expr} ?? {fallback}",
            null_safe=self._null_safe,
            unwrap=self._unwrap,
            placeholder=lambda type_ref, _field: self.placeholder(type_ref),
            expression=make_expression_syntax(
                binary=lambda operator, left, right: f"{left} {operator} {right}",
                not_=lambda value: f"!{operand(value)}",
                conditional=lambda condition, then, otherwise: f"{condition} ? {then} : {otherwise}",
                call=self._call,
            ),
        )

    def placeholder(self, type_ref: dict) -> str:
        if type_ref["kind"] == "enum":
            enum_def = find_enum(self.plan["target"], type_ref["name"])
            if enum_def and enum_def["values"]:
                return self.enum_member(enum_def, enum_def["values"][0]["name"])
        if type_ref["kind"] == "primitive":
            values = {
                "string": '""',
                "integer": "0",
                "float": "0.0",
                "decimal": "0m",
                "boolean": "false",
                "datetime": f"{self.target_date_time}.MinValue",
                "uuid": "Guid.Empty",
            }
            if type_ref["name"] in values:
                return values[type_ref["name"]]
        return "new()" if type_ref["kind"] in ("array", "map", "model") else "default!"

    def class_name(self) -> str:
        return f"{type_name(self.plan['root']['source']['name'])}Mappings"

    def mapper_method(self, mapper: dict) -> str:
        context = roots("source")
        values = [(assignment, self.emitter.assignment(assignment, context)) for assignment in mapper["assignments"]]

        def comment(assignment: dict) -> list[str]:
            return (
                [f'// TODO: no value for "{assignment["field"]["name"]}" in the mapping']
                if assignment["missing"]
                else []
            )

        target = type_name(mapper["target"]["name"])
        if mapper["target"].get("construction") == "positional":
            args = [line for assignment, code in values for line in [*comment(assignment), f"{code or 'default'},"]]
            if args:
                args[-1] = re.sub(r",$", "", args[-1])
            body = f"return new {target}(\n{indent(chr(10).join(args), 4)}\n);"
        else:
            lines = [
                line
                for assignment, code in values
                if code is not None
                for line in [*comment(assignment), f"{self.name(assignment['field'], 'target')} = {code},"]
            ]
            body = (
                f"return new {target}\n{{\n{indent(chr(10).join(lines), 4)}\n}};"
                if lines
                else f"return new {target}();"
            )
        source = type_name(mapper["source"]["name"])
        return (
            f"    public static {target} {self.method_name(mapper)}(this {source} source)\n"
            f"    {{\n        ArgumentNullException.ThrowIfNull(source);\n{indent(body, 8)}\n    }}"
        )

    def namespace(self) -> str:
        return option_value(csharp_generator, self.plan, self.settings, "namespace")


def _header(usings: dict, namespace: str) -> str:
    # System namespaces first, as .NET code usually orders them
    def order(item: str) -> str:
        return f"0{item}" if item == "System" or item.startswith("System.") else f"1{item}"

    lines = [f"using {item};" for item in sorted(usings, key=order)]
    parts = ["\n".join(lines), f"namespace {namespace};" if namespace else ""]
    return "\n\n".join(part for part in parts if part != "")


def _generate_manual(plan: dict, settings: dict) -> dict:
    writer = _Writer(plan, settings)
    writer.usings["System"] = None
    methods = [writer.mapper_method(mapper) for mapper in plan["mappers"]]
    helpers = [code for _, code in writer.helpers.values()]
    name = writer.class_name()
    members = "\n\n".join([*methods, *helpers])
    code = f"{_header(writer.usings, writer.namespace())}\n\npublic static class {name}\n{{\n{members}\n}}\n"
    return {"files": [{"name": f"{name}.cs", "code": code}], "notes": writer.emitter.notes}


def _generate_automapper(plan: dict, settings: dict) -> dict:
    """AutoMapper: one profile with a map per pair of models; ForMember only where conventions do not find the
    value by themselves."""
    writer = _Writer(plan, settings, True)
    writer.usings["AutoMapper"] = None
    maps: list[str] = []
    enum_maps: dict[str, str] = {}
    for mapper in plan["mappers"]:
        members: list[str] = []
        for assignment in mapper["assignments"]:
            target = writer.name(assignment["field"], "target")
            value = assignment["value"]
            if not value:
                if assignment["missing"]:
                    writer.emitter.notes.append(
                        {"code": "missingValue", "params": {"field": assignment["field"]["name"]}}
                    )
                todo = " // TODO: no value in the mapping" if assignment["missing"] else ""
                members.append(f".ForMember(dest => dest.{target}, opt => opt.Ignore()){todo}")
                continue
            inner = value["value"] if value["k"] == "coalesce" else value
            fallback = None
            if value["k"] == "coalesce" and value["fallback"]["k"] == "literal":
                fallback = writer.emitter.value(value["fallback"], roots("src"))
            base = inner["value"] if inner["k"] in ("convert", "mapper", "list", "enumMap") else inner
            # Same name: AutoMapper finds it, converts it and maps nested objects, lists and enums (by their own maps)
            conventional = (
                base["k"] == "path"
                and len(base["steps"]) == 1
                and writer.name(base["steps"][0]["field"], "source") == target
                and (inner["k"] != "enumMap" or inner.get("source") is not None)
            )
            if inner["k"] == "enumMap":
                source = inner.get("source")
                key = f"{source['name'] if source else 'string'}->{inner['target']['name']}"
                if key not in enum_maps and source:
                    call = writer.emitter.syntax.enum_map("value", inner, inner["value"]["type"])
                    enum_maps[key] = (
                        f"CreateMap<{type_name(source['name'])}, {type_name(inner['target']['name'])}>()"
                        f".ConvertUsing(value => {call});"
                    )
            if conventional and not fallback:
                continue
            if base["k"] in ("path", "self") and inner["k"] in ("mapper", "list", "enumMap", "convert"):
                expression = writer.emitter.value(base, roots("src"))
            else:
                expression = writer.emitter.value(inner, roots("src"))
            options = [] if conventional else [f"opt.MapFrom(src => {expression})"]
            if fallback:
                options.append(f"opt.NullSubstitute({fallback})")
            written = options[0] if len(options) == 1 else "{ " + " ".join(f"{item};" for item in options) + " }"
            members.append(f".ForMember(dest => dest.{target}, opt => {written})")
        create = f"CreateMap<{type_name(mapper['source']['name'])}, {type_name(mapper['target']['name'])}>()"
        maps.append(f"{create}\n{indent(chr(10).join(members), 4)};" if members else f"{create};")
    helpers = [code for _, code in writer.helpers.values()]
    name = f"{type_name(plan['root']['source']['name'])}Profile"
    body = indent("\n\n".join([*maps, *enum_maps.values()]), 8)
    constructor = f"    public {name}()\n    {{\n{body}\n    }}"
    writer.usings["System"] = None
    members = "\n\n".join([constructor, *helpers])
    code = f"{_header(writer.usings, writer.namespace())}\n\npublic class {name} : Profile\n{{\n{members}\n}}\n"
    return {"files": [{"name": f"{name}.cs", "code": code}], "notes": writer.emitter.notes}


def _defaults(plan: dict) -> dict:
    is_csharp = (plan["target"].get("origin") or {}).get("language") == "csharp"
    namespace = plan["root"]["target"].get("namespace") if is_csharp else None
    return {"namespace": namespace} if namespace else {}


csharp_generator = CodeGenerator(
    "csharp",
    "C#",
    "csharp",
    ("manual", "automapper"),
    (GeneratorOption("namespace", ("",), "text"),),
    lambda plan, settings: (
        _generate_automapper(plan, settings) if settings["mode"] == "automapper" else _generate_manual(plan, settings)
    ),
    _defaults,
)
