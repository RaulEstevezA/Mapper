"""TypeScript and JavaScript mapping functions. Mirrors web/src/core/generate/languages/typescript.ts."""

import json
import re

from ...js import js_string
from ...model.schema import find_enum
from ..emitter import Emitter, indent, make_expression_syntax, make_syntax, roots
from ..naming import NamingRules, field_name, is_valid_identifier, type_name
from ..plan import all_values, plan_for_plain_objects
from ..types import CodeGenerator, GeneratorOption, option_value

RESERVED = frozenset(
    {
        "break",
        "case",
        "catch",
        "class",
        "const",
        "continue",
        "debugger",
        "default",
        "delete",
        "do",
        "else",
        "enum",
        "export",
        "extends",
        "false",
        "finally",
        "for",
        "function",
        "if",
        "import",
        "in",
        "instanceof",
        "new",
        "null",
        "return",
        "super",
        "switch",
        "this",
        "throw",
        "true",
        "try",
        "typeof",
        "var",
        "void",
        "while",
        "with",
    }
)


def _rules(language: str) -> NamingRules:
    return NamingRules(language, "camelCase", RESERVED, lambda name: f"{name}_", raw_objects=True)


def single(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
    return f"'{escaped}'"


def _member(base: str, name: str, optional: bool) -> str:
    """A property key or member access: name, or ['display-name'] when it is not an identifier."""
    if is_valid_identifier(name):
        return f"{base}{'?.' if optional else '.'}{name}"
    return f"{base}{'?.' if optional else ''}[{single(name)}]"


def _property_key(name: str) -> str:
    return name if is_valid_identifier(name) else single(name)


_SIMPLE = re.compile(r"^[\w$.?\[\]'\"()]+$")


def operand(code: str) -> str:
    """Wraps an expression in parentheses when it is not a simple operand (before .method())."""
    return code if _SIMPLE.match(code) and "??" not in code and " " not in code else f"({code})"


def _is_number(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("integer", "float", "decimal")


def _is_text(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("string", "uuid", "time", "duration")


def _is_date(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("datetime", "date")


def _is_primitive(type_ref: dict, name: str) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] == name


_TEMPLATE_SPECIAL = re.compile(r"[`\\$]")
_CALL = re.compile(r"^(\w+)\((\w+)\)$")
# The object literal closed inside Object.assign(...)
_CLOSING_BRACE = re.compile(r"\n {2}\}$")
CLOSE = "\n  })"


class _Writer:
    def __init__(self, plan: dict, settings: dict, typed: bool):
        self.plan = plan
        self.settings = settings
        self.typed = typed
        naming = _rules("typescript" if typed else "javascript")
        self.emitter = Emitter(
            self._syntax(),
            lambda field, _owner, side: field_name(
                field, plan["source"] if side == "source" else plan["target"], naming, settings["naming"]
            ),
        )
        # Helper functions for enum conversions: name → (key, code)
        self.helpers: dict[str, tuple[str, str]] = {}
        # Names used in code for the source and target models (renamed when both sides use the same name)
        self.source_names: dict[str, str] = {}
        self.target_names: dict[str, str] = {}
        target_models = dict.fromkeys(
            [mapper["target"]["name"] for mapper in plan["mappers"]]
            + [item["name"] for item in plan["enums"]["target"]]
        )
        for name in target_models:
            self.target_names[name] = type_name(name)
        for name in [mapper["source"]["name"] for mapper in plan["mappers"]] + [
            item["name"] for item in plan["enums"]["source"]
        ]:
            code = type_name(name)
            self.source_names[name] = f"Source{code}" if name in target_models else code

    def _names(self, side: str) -> dict:
        return self.source_names if side == "source" else self.target_names

    def type_name(self, type_ref: dict, side: str) -> str:
        kind = type_ref["kind"]
        if kind == "primitive":
            if _is_number(type_ref):
                return "number"
            if type_ref["name"] == "boolean":
                return "boolean"
            if _is_date(type_ref):
                return "Date"
            if type_ref["name"] == "any":
                return "unknown"
            if type_ref["name"] == "binary":
                return "Uint8Array"
            return "string"
        if kind == "array":
            return f"{self.type_name(type_ref['items'], side)}[]"
        if kind == "map":
            return f"Record<string, {self.type_name(type_ref['value'], side)}>"
        if kind in ("model", "enum"):
            return self._names(side).get(type_ref["name"]) or type_name(type_ref["name"])
        return "unknown"

    def enum_value(self, enum_def: dict, name: str, side: str) -> str:
        value = next((item for item in enum_def["values"] if item["name"] == name), None)
        if enum_def.get("kind") == "literals":
            wire = value.get("value") if value else None
            return single(js_string(wire if wire is not None else name))
        owner = self._names(side).get(enum_def["name"]) or enum_def["name"]
        return f"{owner}.{name}" if is_valid_identifier(name) else f"{owner}[{single(name)}]"

    def mapper_name(self, mapper: dict) -> str:
        return f"map{type_name(mapper['source']['name'])}To{type_name(mapper['target']['name'])}"

    def _enum_helper(self, node: dict, origin: dict) -> str:
        source = node.get("source")
        target_name = self.target_names.get(node["target"]["name"]) or node["target"]["name"]
        base = (
            f"map{self.source_names.get(source['name']) or source['name']}To{target_name}"
            if source
            else f"to{target_name}"
        )
        key = json.dumps([node["pairs"], node.get("fallback"), source["name"] if source else None])
        name = base
        n = 2
        while name in self.helpers and self.helpers[name][0] != key:
            name = f"{base}{n}"
            n += 1
        if name not in self.helpers:
            parameter = f"value: {self.type_name(origin, 'source')}" if self.typed else "value"
            returns = f": {target_name}" if self.typed else ""
            cases = []
            for pair in node["pairs"]:
                label = self.enum_value(source, pair["from"], "source") if source else single(pair["from"])
                cases.append(f"    case {label}:\n      return {self.enum_value(node['target'], pair['to'], 'target')}")
            if "fallback" in node:
                fallback = f"    default:\n      return {self.enum_value(node['target'], node['fallback'], 'target')}"
            else:
                described = source["name"] if source else "value"
                fallback = f"    default:\n      throw new Error(`Unexpected {described}: ${{String(value)}}`)"
            doc = (
                ""
                if self.typed
                else f"/** @param {{{self.type_name(origin, 'source')}}} value @returns {{{target_name}}} */\n"
            )
            body = "\n".join([*cases, fallback])
            code = f"{doc}function {name}({parameter}){returns} {{\n  switch (value) {{\n{body}\n  }}\n}}"
            self.helpers[name] = (key, code)
        return name

    def _literal(self, value, type_ref: dict) -> str:
        if value is None:
            return "null"
        if type_ref["kind"] == "enum" and isinstance(value, str):
            enum_def = find_enum(self.plan["target"], type_ref["name"])
            if enum_def:
                return self.enum_value(enum_def, value, "target")
        if isinstance(value, str):
            return f"new Date({single(value)})" if _is_date(type_ref) else single(value)
        return js_string(value)

    def _convert(self, expr: str, origin: dict, to: dict) -> str:
        if _is_number(origin) and _is_number(to):
            if _is_primitive(to, "integer") and not _is_primitive(origin, "integer"):
                return f"Math.trunc({expr})"
            return expr
        if _is_primitive(to, "string"):
            if _is_date(origin):
                return f"{operand(expr)}.toISOString()"
            literals = (
                origin["kind"] == "enum"
                and (find_enum(self.plan["source"], origin["name"]) or {}).get("kind") == "literals"
            )
            if _is_text(origin) or literals:
                return expr
            return f"String({expr})"
        if _is_text(origin) and _is_primitive(to, "integer"):
            return f"Number.parseInt({expr}, 10)"
        if _is_text(origin) and _is_number(to):
            return f"Number({expr})"
        if _is_text(origin) and _is_date(to):
            return f"new Date({expr})"
        if _is_primitive(origin, "boolean") and _is_number(to):
            return f"({expr} ? 1 : 0)"
        if to["kind"] == "enum" or _is_primitive(origin, "any"):
            return f"({expr} as {self.type_name(to, 'target')})" if self.typed else expr
        return expr

    def _split(self, expr: str, separator: str, part) -> str:
        split = f"{operand(expr)}.split({single(separator)})"
        if part == "rest":
            return f"{split}.slice(1).join({single(separator)})"
        if part == "last":
            return f"({split}.at(-1) ?? '')"
        return f"({split}[{part}] ?? '')"

    def _boolean(self, expr: str, true_values: list, origin: dict) -> str:
        enum_def = find_enum(self.plan["source"], origin["name"]) if origin["kind"] == "enum" else None
        values = [self.enum_value(enum_def, value, "source") if enum_def else single(value) for value in true_values]
        return f"{expr} === {values[0]}" if len(values) == 1 else f"[{', '.join(values)}].includes({expr})"

    def _epoch(self, expr: str, unit: str, to_date: bool, _origin: dict, _to: dict) -> str:
        if to_date:
            return f"new Date({operand(expr)} * 1000)" if unit == "seconds" else f"new Date({expr})"
        return f"Math.floor({operand(expr)}.getTime() / 1000)" if unit == "seconds" else f"{operand(expr)}.getTime()"

    def _list(self, expr: str, item: str, element: str, is_map: bool, element_is_item: bool, _container) -> str:
        if is_map:
            if element_is_item:
                return f"{{ ...{expr} }}"
            return f"Object.fromEntries(Object.entries({expr}).map(([key, {item}]) => [key, {element}]))"
        if element_is_item:
            return f"[...{expr}]"
        call = _CALL.match(element)
        if call and call.group(2) == item:
            return f"{operand(expr)}.map({call.group(1)})"
        return f"{operand(expr)}.map(({item}) => {element})"

    def _call(self, name: str, args: list[str]) -> str:
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
            return "`" + "".join(f"${{{arg}}}" for arg in args) + "`"
        if name == "substring":
            return (
                f"{operand(a)}.substring({b})"
                if c is None
                else f"{operand(a)}.substring({b}, {operand(b)} + {operand(c)})"
            )
        if name == "replace":
            return f"{operand(a)}.replaceAll({b}, {c})"
        if name in ("round", "floor", "ceil", "abs", "min", "max"):
            return f"Math.{name}({', '.join(args)})"
        if name == "toString":
            return f"String({a})"
        return f"Number({a})"

    def _syntax(self):
        typed = self.typed

        def binary(operator: str, left: str, right: str) -> str:
            written = "===" if operator == "==" else "!==" if operator == "!=" else operator
            return f"{left} {written} {right}"

        def concat(parts: list[str], separator: str) -> str:
            escaped = _TEMPLATE_SPECIAL.sub(lambda match: f"\\{match.group(0)}", separator)
            return "`" + escaped.join(f"${{{part}}}" for part in parts) + "`"

        return make_syntax(
            access=lambda base, _step, name: _member(base, name, False),
            safe_access=lambda base, _step, name: _member(base, name, True),
            literal=self._literal,
            convert=self._convert,
            concat=concat,
            split=self._split,
            boolean=self._boolean,
            enum_map=lambda expr, node, origin: f"{self._enum_helper(node, origin)}({expr})",
            epoch=self._epoch,
            arithmetic=lambda expr, operator, value, _type: f"{operand(expr)} {operator} {js_string(value)}",
            mapper_call=lambda mapper, expr: f"{self.mapper_name(mapper)}({expr})",
            list=self._list,
            coalesce=lambda expr, fallback, _type: f"{expr} ?? {fallback}",
            null_safe=lambda expr, build, _context: f"{expr} == null ? undefined : {build(expr)}",
            unwrap=lambda expr, _type: f"{operand(expr)}!" if typed else expr,
            placeholder=lambda type_ref, _field: self._placeholder(type_ref),
            expression=make_expression_syntax(
                binary=binary,
                not_=lambda value: f"!{operand(value)}",
                conditional=lambda condition, then, otherwise: f"{condition} ? {then} : {otherwise}",
                call=self._call,
            ),
        )

    def _placeholder(self, type_ref: dict) -> str:
        if type_ref["kind"] == "array":
            return "[]"
        if type_ref["kind"] == "map":
            return "{}"
        if type_ref["kind"] == "enum":
            enum_def = find_enum(self.plan["target"], type_ref["name"])
            if enum_def and enum_def["values"]:
                return self.enum_value(enum_def, enum_def["values"][0]["name"], "target")
        if type_ref["kind"] == "primitive":
            if _is_number(type_ref):
                return "0"
            if type_ref["name"] == "boolean":
                return "false"
            if _is_date(type_ref):
                return "new Date(0)"
            if type_ref["name"] == "string" or _is_text(type_ref):
                return "''"
        return f"undefined as unknown as {self.type_name(type_ref, 'target')}" if self.typed else "undefined"

    def _target_field_name(self, field: dict) -> str:
        rules = _rules("typescript" if self.typed else "javascript")
        return field_name(field, self.plan["target"], rules, self.settings["naming"])

    def mapper_function(self, mapper: dict) -> str:
        context = roots("source")
        lines: list[str] = []
        for assignment in mapper["assignments"]:
            code = self.emitter.assignment(assignment, context)
            if code is None:
                continue
            field = assignment["field"]
            key = _property_key(self._target_field_name(field))
            value = assignment["value"]
            if assignment["missing"]:
                lines.append(f'// TODO: no value for "{field["name"]}" in the mapping')
            elif assignment["unsafeNull"]:
                lines.append(f'// TODO: the source may be missing, but "{field["name"]}" is required')
            elif value and value["nullable"] and field["nullable"] and not field["optional"]:
                code = f"{code} ?? null"
            lines.append(f"{key}," if code == key else f"{key}: {code},")
        source_type = self.source_names.get(mapper["source"]["name"]) or mapper["source"]["name"]
        target_type = self.target_names.get(mapper["target"]["name"]) or mapper["target"]["name"]
        body = "{\n" + indent("\n".join(lines), 4) + "\n  }" if lines else "{}"
        is_class = mapper["target"]["kind"] in ("class", "entity")
        result = f"Object.assign(new {target_type}(), {_CLOSING_BRACE.sub(lambda _: CLOSE, body)}" if is_class else body
        name = self.mapper_name(mapper)
        if self.typed:
            return f"export function {name}(source: {source_type}): {target_type} {{\n  return {result}\n}}"
        return (
            f"/**\n * @param {{{source_type}}} source\n * @returns {{{target_type}}}\n */\n"
            f"export function {name}(source) {{\n  return {result}\n}}"
        )

    def imports(self) -> str:
        if not self.typed:
            return ""
        plan = self.plan
        used_source: dict[str, None] = {}
        used_target: dict[str, None] = {}
        for mapper in plan["mappers"]:
            used_source[mapper["source"]["name"]] = None
            used_target[mapper["target"]["name"]] = None
        for value in all_values(plan):
            if value["k"] == "enumMap":
                used_target[value["target"]["name"]] = None
                if value.get("source"):
                    used_source[value["source"]["name"]] = None
            if value["k"] == "boolean" and value["value"]["type"]["kind"] == "enum":
                used_source[value["value"]["type"]["name"]] = None
            if value["k"] == "literal" and value["type"]["kind"] == "enum":
                used_target[value["type"]["name"]] = None
        for mapper in plan["mappers"]:
            for assignment in mapper["assignments"]:
                if assignment["missing"] and assignment["field"]["type"]["kind"] == "enum":
                    used_target[assignment["field"]["type"]["name"]] = None

        # Enums and classes are values (Status.Active, new User()); interfaces and literal unions are types
        def is_type(schema: dict, name: str) -> bool:
            enum_def = find_enum(schema, name)
            if enum_def:
                return enum_def.get("kind") == "literals"
            model = next((item for item in schema["models"] if item["name"] == name), None)
            return not (model and schema is plan["target"] and model["kind"] in ("class", "entity"))

        source_module = option_value(typescript_generator, plan, self.settings, "sourceModule")
        target_module = option_value(typescript_generator, plan, self.settings, "targetModule")
        renamed = any(name != code and name in used_source for name, code in self.source_names.items())
        if renamed and target_module == source_module:
            target_module = "./target-models"

        def statement(names: dict, schema: dict, code_names: dict, module: str) -> list[str]:
            if not names:
                return []
            entries = []
            for name in sorted(names):
                code = code_names.get(name) or name
                type_only = is_type(schema, name)
                imported = code if code == type_name(name) else f"{type_name(name)} as {code}"
                entries.append((f"type {imported}" if type_only else imported, type_only))
            if all(type_only for _, type_only in entries):
                listed = ", ".join(text[len("type ") :] if text.startswith("type ") else text for text, _ in entries)
                return [f"import type {{ {listed} }} from {single(module)}"]
            return [f"import {{ {', '.join(text for text, _ in entries)} }} from {single(module)}"]

        if source_module == target_module:
            merged = {**used_source, **used_target}
            names = {**self.source_names, **self.target_names}
            schema = {
                **plan["target"],
                "models": [*plan["source"]["models"], *plan["target"]["models"]],
                "enums": [*plan["source"]["enums"], *plan["target"]["enums"]],
            }
            return "\n".join(statement(merged, schema, names, source_module))
        return "\n".join(
            [
                *statement(used_source, plan["source"], self.source_names, source_module),
                *statement(used_target, plan["target"], self.target_names, target_module),
            ]
        )


def _generate(original: dict, settings: dict, typed: bool) -> dict:
    # JSON read with JSON.parse keeps dates and ids as text
    plan = plan_for_plain_objects(original, True, True)
    writer = _Writer(plan, settings, typed)
    functions = [writer.mapper_function(mapper) for mapper in plan["mappers"]]
    helpers = [code for _, code in writer.helpers.values()]
    imports = writer.imports()
    code = "\n\n".join(part for part in [imports, *functions, *helpers] if part != "") + "\n"
    return {"files": [{"name": "mapper.ts" if typed else "mapper.js", "code": code}], "notes": writer.emitter.notes}


typescript_generator = CodeGenerator(
    "typescript",
    "TypeScript",
    "typescript",
    ("functions",),
    (GeneratorOption("sourceModule", ("./models",), "text"), GeneratorOption("targetModule", ("./models",), "text")),
    lambda plan, settings: _generate(plan, settings, True),
)

javascript_generator = CodeGenerator(
    "javascript",
    "JavaScript",
    "javascript",
    ("functions",),
    (),
    lambda plan, settings: _generate(plan, settings, False),
)
