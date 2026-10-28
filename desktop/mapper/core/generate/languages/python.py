"""Python mapping functions, for classes or dictionaries. Mirrors web/src/core/generate/languages/python.ts."""

import json
import re

from ...js import js_string
from ...model.naming import to_screaming_snake_case, to_snake_case
from ...model.schema import find_enum
from ..emitter import Emitter, indent, make_expression_syntax, make_syntax, roots
from ..naming import NamingRules, field_name, is_valid_identifier, type_name
from ..plan import all_values, is_document_schema, plan_for_plain_objects
from ..types import CodeGenerator, GeneratorOption, option_value

RESERVED = frozenset(
    {
        "False",
        "None",
        "True",
        "and",
        "as",
        "assert",
        "async",
        "await",
        "break",
        "class",
        "continue",
        "def",
        "del",
        "elif",
        "else",
        "except",
        "finally",
        "for",
        "from",
        "global",
        "if",
        "import",
        "in",
        "is",
        "lambda",
        "nonlocal",
        "not",
        "or",
        "pass",
        "raise",
        "return",
        "try",
        "while",
        "with",
        "yield",
    }
)


def _is_number(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("integer", "float", "decimal")


def _is_primitive(type_ref: dict, *names: str) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in names


def quote(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


_SIMPLE = re.compile(r'^[\w.\[\]"()]+$')


def operand(code: str) -> str:
    """Parenthesizes an expression that is not a simple operand."""
    return code if _SIMPLE.match(code) and " " not in code else f"({code})"


_BRACES = re.compile(r"[{}]")
_SPECIAL = re.compile(r"[\"'\\{}]")


class _Writer:
    def __init__(self, plan: dict, settings: dict, source_dict: bool, target_dict: bool):
        self.plan = plan
        self.settings = settings
        self.source_dict = source_dict
        self.target_dict = target_dict
        # Dictionaries keep the document's keys; classes use Python names
        self.naming = NamingRules("python", "snake_case", RESERVED, lambda name: f"{name}_")
        self.imports: dict[str, dict[str, None]] = {}
        self.helpers: dict[str, tuple[str, str]] = {}
        self.emitter = Emitter(self._syntax(), lambda field, _owner, side: self._name(field, side))

    def _name(self, field: dict, side: str) -> str:
        if self.source_dict if side == "source" else self.target_dict:
            return field["name"]
        schema = self.plan["source"] if side == "source" else self.plan["target"]
        return field_name(field, schema, self.naming, self.settings["naming"])

    def use(self, module: str, name: str) -> None:
        self.imports.setdefault(module, {})[name] = None

    def mapper_name(self, mapper: dict) -> str:
        return f"map_{to_snake_case(mapper['source']['name'])}_to_{to_snake_case(mapper['target']['name'])}"

    def enum_member(self, enum_def: dict, name: str, as_dict: bool) -> str:
        value = next((item for item in enum_def["values"] if item["name"] == name), None)
        # In a document, or for a set of literals, the value itself is written
        if as_dict or enum_def.get("kind") == "literals":
            wire = value.get("value") if value else None
            if isinstance(wire, (int, float)) and not isinstance(wire, bool):
                return js_string(wire)
            return quote(js_string(wire if wire is not None else name))
        member = name if is_valid_identifier(name) else to_screaming_snake_case(name)
        return f"{type_name(enum_def['name'])}.{member}"

    def _literal(self, value, type_ref: dict) -> str:
        if value is None:
            return "None"
        if isinstance(value, bool):
            return "True" if value else "False"
        if type_ref["kind"] == "enum" and isinstance(value, str):
            enum_def = find_enum(self.plan["target"], type_ref["name"])
            if enum_def:
                return self.enum_member(enum_def, value, self.target_dict)
        if isinstance(value, (int, float)):
            if _is_primitive(type_ref, "decimal"):
                self.use("decimal", "Decimal")
                return f"Decimal({quote(js_string(value))})"
            if _is_primitive(type_ref, "float") and float(value).is_integer():
                return f"{js_string(value)}.0"
            return js_string(value)
        if _is_primitive(type_ref, "datetime") and not self.target_dict:
            self.use("datetime", "datetime")
            return f"datetime.fromisoformat({quote(value)})"
        return quote(value)

    def _enum_helper(self, node: dict) -> str:
        source = node.get("source")
        base = f"_map_{to_snake_case(source['name'] if source else 'value')}_to_{to_snake_case(node['target']['name'])}"
        key = json.dumps([node["pairs"], node.get("fallback"), source["name"] if source else None])
        name = base
        n = 2
        while name in self.helpers and self.helpers[name][0] != key:
            name = f"{base}_{n}"
            n += 1
        if name not in self.helpers:
            table = re.sub(r"^_MAP_", "_", name.upper())
            entries = []
            for pair in node["pairs"]:
                origin = self.enum_member(source, pair["from"], self.source_dict) if source else quote(pair["from"])
                entries.append(f"    {origin}: {self.enum_member(node['target'], pair['to'], self.target_dict)},")
            if "fallback" in node:
                lookup = f"{table}.get(value, {self.enum_member(node['target'], node['fallback'], self.target_dict)})"
            else:
                lookup = f"{table}[value]"
            source_type = type_name(source["name"]) if source and not self.source_dict else "str"
            target_type = "str" if self.target_dict else type_name(node["target"]["name"])
            body = "\n".join(entries)
            code = (
                f"{table} = {{\n{body}\n}}\n\n\ndef {name}(value: {source_type}) -> {target_type}:\n    return {lookup}"
            )
            self.helpers[name] = (key, code)
        return name

    def _access(self, base: str, name: str, nullable: bool, as_dict: bool) -> str:
        if not as_dict:
            return f"{base}.{name}"
        return f"{base}.get({quote(name)})" if nullable else f"{base}[{quote(name)}]"

    def _concat(self, parts: list[str], separator: str) -> str:
        if all(not _SPECIAL.search(part) for part in parts):
            doubled = _BRACES.sub(lambda match: match.group(0) * 2, separator)
            return f"f{quote(doubled.join(f'{{{part}}}' for part in parts))}"
        return f"{quote(separator)}.join([{', '.join(parts)}])"

    def _split(self, expr: str, separator: str, part) -> str:
        sep = quote(separator)
        if part == 0:
            return f"{operand(expr)}.split({sep})[0]"
        if part == "rest":
            return f"{operand(expr)}.partition({sep})[2]"
        if part == "last":
            return f"{operand(expr)}.rsplit({sep}, 1)[-1]"
        return f'({operand(expr)}.split({sep}) + [""] * {part + 1})[{part}]'

    def _boolean(self, expr: str, true_values: list, origin: dict) -> str:
        enum_def = find_enum(self.plan["source"], origin["name"]) if origin["kind"] == "enum" else None
        values = [
            self.enum_member(enum_def, value, self.source_dict) if enum_def else quote(value) for value in true_values
        ]
        return f"{expr} == {values[0]}" if len(values) == 1 else f"{expr} in ({', '.join(values)})"

    def _epoch(self, expr: str, unit: str, to_date: bool, _origin: dict, _to: dict) -> str:
        if to_date:
            self.use("datetime", "datetime")
            self.use("datetime", "timezone")
            seconds = expr if unit == "seconds" else f"{operand(expr)} / 1000"
            return f"datetime.fromtimestamp({seconds}, tz=timezone.utc)"
        if unit == "seconds":
            return f"int({operand(expr)}.timestamp())"
        return f"int({operand(expr)}.timestamp() * 1000)"

    def _list(self, expr: str, item: str, element: str, is_map: bool, element_is_item: bool, _container) -> str:
        if is_map:
            return (
                f"dict({expr})" if element_is_item else f"{{key: {element} for key, {item} in {operand(expr)}.items()}}"
            )
        return f"list({expr})" if element_is_item else f"[{element} for {item} in {expr}]"

    def _binary(self, operator: str, left: str, right: str) -> str:
        if operator == "&&":
            return f"{left} and {right}"
        if operator == "||":
            return f"{left} or {right}"
        if operator == "??":
            return f"{operand(left)} if {operand(left)} is not None else {right}"
        return f"{left} {operator} {right}"

    def _call(self, name: str, args: list[str]) -> str:
        a = args[0] if args else None
        b = args[1] if len(args) > 1 else None
        c = args[2] if len(args) > 2 else None
        if name in ("upper", "lower"):
            return f"{operand(a)}.{name}()"
        if name == "trim":
            return f"{operand(a)}.strip()"
        if name == "length":
            return f"len({a})"
        if name == "concat":
            return '"".join([' + ", ".join(f"str({arg})" for arg in args) + "])"
        if name == "substring":
            return f"{operand(a)}[{b}:]" if c is None else f"{operand(a)}[{b}:{operand(b)} + {operand(c)}]"
        if name == "replace":
            return f"{operand(a)}.replace({b}, {c})"
        if name in ("round", "abs", "min", "max"):
            return f"{name}({', '.join(args)})"
        if name in ("floor", "ceil"):
            self.use("math", name)
            return f"{name}({a})"
        if name == "toString":
            return f"str({a})"
        return f"float({a})"

    def _syntax(self):
        return make_syntax(
            access=lambda base, step, name: self._access(base, name, step["nullable"], self.source_dict),
            literal=self._literal,
            convert=self._convert,
            concat=self._concat,
            split=self._split,
            boolean=self._boolean,
            enum_map=lambda expr, node, _origin: f"{self._enum_helper(node)}({expr})",
            epoch=self._epoch,
            arithmetic=lambda expr, operator, value, _type: f"{operand(expr)} {operator} {js_string(value)}",
            mapper_call=lambda mapper, expr: f"{self.mapper_name(mapper)}({expr})",
            list=self._list,
            coalesce=lambda expr, fallback, _type: f"{operand(expr)} if {operand(expr)} is not None else {fallback}",
            null_safe=lambda expr, build, _context: f"{build(expr)} if {operand(expr)} is not None else None",
            unwrap=lambda expr, _type: expr,
            placeholder=lambda type_ref, _field: self._placeholder(type_ref),
            expression=make_expression_syntax(
                binary=self._binary,
                not_=lambda value: f"not {operand(value)}",
                conditional=lambda condition, then, otherwise: f"{then} if {condition} else {otherwise}",
                call=self._call,
            ),
        )

    def _convert(self, expr: str, origin: dict, to: dict) -> str:
        if _is_number(origin) and _is_number(to):
            if _is_primitive(to, "integer") and not _is_primitive(origin, "integer"):
                return f"int({expr})"
            if _is_primitive(to, "decimal") and not _is_primitive(origin, "decimal"):
                self.use("decimal", "Decimal")
                return f"Decimal(str({expr}))" if _is_primitive(origin, "float") else f"Decimal({expr})"
            if _is_primitive(to, "float") and _is_primitive(origin, "decimal"):
                return f"float({expr})"
            return expr
        if _is_primitive(to, "string"):
            if _is_primitive(origin, "datetime", "date", "time"):
                return f"{operand(expr)}.isoformat()"
            if origin["kind"] == "enum":
                enum_def = find_enum(self.plan["source"], origin["name"])
                literals = bool(enum_def) and enum_def.get("kind") == "literals"
                return expr if self.source_dict or literals else f"{operand(expr)}.value"
            if _is_primitive(origin, "string"):
                return expr
            return f"str({expr})"
        if _is_primitive(origin, "string", "any"):
            if _is_primitive(to, "integer"):
                return f"int({expr})"
            if _is_primitive(to, "float"):
                return f"float({expr})"
            if _is_primitive(to, "decimal"):
                self.use("decimal", "Decimal")
                return f"Decimal({expr})"
            for name, cls in (("datetime", "datetime"), ("date", "date"), ("time", "time")):
                if _is_primitive(to, name):
                    self.use("datetime", cls)
                    return f"{cls}.fromisoformat({expr})"
            if _is_primitive(to, "uuid"):
                self.use("uuid", "UUID")
                return f"UUID({expr})"
            if to["kind"] == "enum":
                enum_def = find_enum(self.plan["target"], to["name"])
                literals = bool(enum_def) and enum_def.get("kind") == "literals"
                return expr if self.target_dict or literals else f"{type_name(to['name'])}({expr})"
        if _is_primitive(origin, "date") and _is_primitive(to, "datetime"):
            self.use("datetime", "datetime")
            return f"datetime.combine({expr}, datetime.min.time())"
        if _is_primitive(origin, "datetime") and _is_primitive(to, "date"):
            return f"{operand(expr)}.date()"
        if _is_primitive(origin, "boolean") and _is_primitive(to, "integer"):
            return f"int({expr})"
        return expr

    def _placeholder(self, type_ref: dict) -> str:
        if type_ref["kind"] == "array":
            return "[]"
        if type_ref["kind"] == "map":
            return "{}"
        if type_ref["kind"] == "enum":
            enum_def = find_enum(self.plan["target"], type_ref["name"])
            if enum_def and enum_def["values"]:
                return self.enum_member(enum_def, enum_def["values"][0]["name"], self.target_dict)
        if type_ref["kind"] == "primitive":
            name = type_ref["name"]
            if name in ("string", "uuid"):
                return '""'
            if name == "integer":
                return "0"
            if name == "float":
                return "0.0"
            if name == "decimal":
                self.use("decimal", "Decimal")
                return 'Decimal("0")'
            if name == "boolean":
                return "False"
            if name == "datetime":
                self.use("datetime", "datetime")
                self.use("datetime", "timezone")
                return "datetime.fromtimestamp(0, tz=timezone.utc)"
        return "None"

    def _target_key(self, field: dict) -> str:
        if self.target_dict:
            return field["name"]
        # Pydantic models with an alias are built with the alias unless populate_by_name is set
        model = next(
            (item for item in self.plan["target"]["models"] if any(own is field for own in item["fields"])), None
        )
        serialized = field.get("serializedName")
        if model and model.get("framework") == "pydantic" and serialized and is_valid_identifier(serialized):
            return serialized
        return self._name(field, "target")

    def mapper_function(self, mapper: dict) -> str:
        context = roots("source")
        lines: list[str] = []
        for assignment in mapper["assignments"]:
            code = self.emitter.assignment(assignment, context)
            if code is None:
                continue
            field = assignment["field"]
            key = self._target_key(field)
            if assignment["missing"]:
                lines.append(f'# TODO: no value for "{field["name"]}" in the mapping')
            elif assignment["unsafeNull"]:
                lines.append(f'# TODO: the source may be missing, but "{field["name"]}" is required')
            lines.append(f"{quote(key)}: {code}," if self.target_dict else f"{key}={code},")
        source_type = "dict[str, Any]" if self.source_dict else type_name(mapper["source"]["name"])
        target_type = "dict[str, Any]" if self.target_dict else type_name(mapper["target"]["name"])
        if self.source_dict or self.target_dict:
            self.use("typing", "Any")
        inner = indent("\n".join(lines), 8)
        if lines:
            body = f"{{\n{inner}\n    }}" if self.target_dict else f"{target_type}(\n{inner}\n    )"
        else:
            body = "{}" if self.target_dict else f"{target_type}()"
        return f"def {self.mapper_name(mapper)}(source: {source_type}) -> {target_type}:\n    return {body}"

    def import_block(self) -> str:
        lines = [
            f"from {module} import {', '.join(sorted(self.imports[module]))}"
            for module in ("datetime", "decimal", "math", "typing", "uuid")
            if module in self.imports
        ]
        models: set[str] = set()
        for mapper in self.plan["mappers"]:
            if not self.source_dict:
                models.add(type_name(mapper["source"]["name"]))
            if not self.target_dict:
                models.add(type_name(mapper["target"]["name"]))
        for value in all_values(self.plan):
            kind = value["k"]
            if kind == "enumMap":
                source = value.get("source")
                if source and not self.source_dict and source.get("kind") != "literals":
                    models.add(type_name(source["name"]))
                if not self.target_dict and value["target"].get("kind") != "literals":
                    models.add(type_name(value["target"]["name"]))
            if kind == "boolean" and value["value"]["type"]["kind"] == "enum" and not self.source_dict:
                enum_def = find_enum(self.plan["source"], value["value"]["type"]["name"])
                if enum_def and enum_def.get("kind") != "literals":
                    models.add(type_name(enum_def["name"]))
            if kind in ("literal", "convert") and value["type"]["kind"] == "enum" and not self.target_dict:
                enum_def = find_enum(self.plan["target"], value["type"]["name"])
                if enum_def and enum_def.get("kind") != "literals":
                    models.add(type_name(enum_def["name"]))
        module = option_value(python_generator, self.plan, self.settings, "modelsModule")
        if models:
            lines.extend(["", f"from {module} import {', '.join(sorted(models))}"])
        return "\n".join(lines)


def _generate(original: dict, settings: dict) -> dict:
    source_dict = option_value(python_generator, original, settings, "sourceAccess") == "dict"
    target_dict = option_value(python_generator, original, settings, "targetStyle") == "dict"
    plan = plan_for_plain_objects(original, source_dict, target_dict)
    writer = _Writer(plan, settings, source_dict, target_dict)
    functions = [writer.mapper_function(mapper) for mapper in plan["mappers"]]
    helpers = [code for _, code in writer.helpers.values()]
    imports = writer.import_block()
    code = "\n\n\n".join(part for part in [imports, *functions, *helpers] if part != "") + "\n"
    return {"files": [{"name": "mapper.py", "code": code}], "notes": writer.emitter.notes}


python_generator = CodeGenerator(
    "python",
    "Python",
    "python",
    ("functions",),
    (
        GeneratorOption("sourceAccess", ("attribute", "dict")),
        GeneratorOption("targetStyle", ("constructor", "dict")),
        GeneratorOption("modelsModule", ("models",), "text"),
    ),
    _generate,
    # A JSON document arrives as a dict; a class from code is read by its attributes
    lambda plan: {
        "sourceAccess": "dict" if is_document_schema(plan["source"]) else "attribute",
        "targetStyle": "dict" if is_document_schema(plan["target"]) else "constructor",
    },
)
