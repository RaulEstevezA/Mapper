"""Writes plan values as expressions. Mirrors web/src/core/generate/emitter.ts. A language describes its syntax
with a Syntax; the emitter decides where null checks are needed and which conversions apply, the same for every
language."""

import json
from types import SimpleNamespace


def make_syntax(**members) -> SimpleNamespace:
    """How a language writes values: access, literal, convert, concat, split, boolean, enum_map, epoch,
    arithmetic, mapper_call, list, coalesce, null_safe, unwrap, placeholder and expression (binary, not_,
    conditional, call), like the web version's Syntax object. safe_access (a field of a value that may be null,
    giving null) and wrap_optional (Rust Some) are optional; variable_prefix is written before variable names
    ($ in PHP). A null-safe context is {"type", "resultType", "resultNullable", "variable"}."""
    defaults = {"safe_access": None, "wrap_optional": None, "variable_prefix": ""}
    return SimpleNamespace(**{**defaults, **members})


def make_expression_syntax(binary, not_, conditional, call) -> SimpleNamespace:
    return SimpleNamespace(binary=binary, not_=not_, conditional=conditional, call=call)


_PRECEDENCE = {
    "??": 1,
    "||": 2,
    "&&": 3,
    "==": 4,
    "!=": 4,
    "<": 5,
    "<=": 5,
    ">": 5,
    ">=": 5,
    "+": 6,
    "-": 6,
    "*": 7,
    "/": 7,
    "%": 7,
}


def roots(source: str, item: str = "item") -> dict:
    """Names of the source object and of the current list element, a counter for fresh variable names and the
    number of lists entered so far (nested lists name their elements item, item2, item3…)."""
    return {"source": source, "item": item, "depth": 0, "lists": 0}


class Emitter:
    def __init__(self, syntax: SimpleNamespace, field_name):
        self.syntax = syntax
        # Name of a field in code, for each side: field_name(field, owner, side)
        self.field_name = field_name
        self.notes: list[dict] = []

    def assignment(self, assignment: dict, roots_: dict) -> str | None:
        """The value of an assignment, with a placeholder or an assertion when the mapping leaves it incomplete."""
        field = assignment["field"]
        if assignment["missing"]:
            self.notes.append({"code": "missingValue", "params": {"field": field["name"]}})
            return self.syntax.placeholder(field["type"], field)
        if not assignment["value"]:
            return None
        code = self.value(assignment["value"], roots_)
        if assignment["unsafeNull"]:
            self.notes.append({"code": "unsafeNull", "params": {"field": field["name"]}})
            code = self.syntax.unwrap(code, field["type"])
        elif (
            (field["nullable"] or field["optional"])
            and self.syntax.wrap_optional
            and not assignment["value"]["nullable"]
        ):
            code = self.syntax.wrap_optional(code, field["type"])
        return code

    def _fresh(self, roots_: dict) -> str:
        roots_["depth"] += 1
        depth = roots_["depth"]
        return f"{self.syntax.variable_prefix}{'value' if depth == 1 else f'value{depth}'}"

    def _guarded(self, value: dict, roots_: dict, result_type: dict, build, result_nullable: bool = False) -> str:
        """Applies build to the value, guarding it when it may be null."""
        expr = self.value(value, roots_)
        if not value["nullable"]:
            return build(expr)
        context = {
            "type": value["type"],
            "resultType": result_type,
            "resultNullable": result_nullable,
            "variable": self._fresh(roots_),
        }
        return self.syntax.null_safe(expr, build, context)

    def value(self, value: dict, roots_: dict) -> str:
        syntax = self.syntax
        kind = value["k"]
        if kind == "path":
            code = roots_["source"] if value["root"] == "source" else roots_["item"]
            nullable = False
            for step in value["steps"]:
                name = self.field_name(step["field"], step["owner"], "source")
                if nullable:
                    if syntax.safe_access:
                        code = syntax.safe_access(code, step, name)
                    else:
                        context = {
                            "type": {"kind": "model", "name": step["owner"]["name"]},
                            "resultType": step["field"]["type"],
                            "resultNullable": step["nullable"],
                            "variable": self._fresh(roots_),
                        }
                        code = syntax.null_safe(
                            code, lambda inner, step=step, name=name: syntax.access(inner, step, name), context
                        )
                else:
                    code = syntax.access(code, step, name)
                nullable = nullable or step["nullable"]
            return code
        if kind == "self":
            return roots_["source"] if value["root"] == "source" else roots_["item"]
        if kind == "literal":
            return syntax.literal(value["value"], value["type"])
        inner = value.get("value")
        if kind == "convert":
            return self._guarded(
                inner, roots_, value["type"], lambda code: syntax.convert(code, inner["type"], value["type"])
            )
        if kind == "concat":
            return syntax.concat([self.value(part, roots_) for part in value["parts"]], value["separator"])
        if kind == "split":
            return self._guarded(
                inner, roots_, value["type"], lambda code: syntax.split(code, value["separator"], value["part"])
            )
        if kind == "boolean":
            return self._guarded(
                inner, roots_, value["type"], lambda code: syntax.boolean(code, value["trueValues"], inner["type"])
            )
        if kind == "enumMap":
            source_values = len(value["source"]["values"]) if value.get("source") else 0
            if len(value["pairs"]) < source_values and "fallback" not in value:
                self.notes.append({"code": "enumFallbackThrows", "params": {"enum": value["target"]["name"]}})
            return self._guarded(inner, roots_, value["type"], lambda code: syntax.enum_map(code, value, inner["type"]))
        if kind == "epoch":
            return self._guarded(
                inner,
                roots_,
                value["type"],
                lambda code: syntax.epoch(code, value["unit"], value["toDate"], inner["type"], value["type"]),
            )
        if kind == "arithmetic":
            return self._guarded(
                inner,
                roots_,
                value["type"],
                lambda code: syntax.arithmetic(code, value["operator"], value["operand"], value["type"]),
            )
        if kind == "mapper":
            return self._guarded(inner, roots_, value["type"], lambda code: syntax.mapper_call(value["mapper"], code))
        if kind == "list":
            lists = roots_["lists"]
            item = f"{syntax.variable_prefix}{'item' if lists == 0 else f'item{lists + 1}'}"
            element_roots = {"source": roots_["source"], "item": item, "depth": roots_["depth"], "lists": lists + 1}
            element = self.value(value["element"], element_roots)
            element_is_item = value["element"]["k"] == "self"
            return self._guarded(
                inner,
                roots_,
                value["type"],
                lambda code: syntax.list(code, item, element, value["isMap"], element_is_item, value.get("container")),
            )
        if kind == "coalesce":
            return syntax.coalesce(self.value(inner, roots_), self.value(value["fallback"], roots_), value["type"])
        return self._expression(value["expr"], value["fields"], roots_, 0)

    def _expression(self, expr: dict, fields: dict, roots_: dict, parent: int) -> str:
        syntax = self.syntax.expression
        kind = expr["kind"]
        if kind == "literal":
            literal = expr["value"]
            if isinstance(literal, (int, float)) and not isinstance(literal, bool):
                type_ref = {"kind": "primitive", "name": "integer" if float(literal).is_integer() else "float"}
            else:
                type_ref = {"kind": "primitive", "name": "boolean" if isinstance(literal, bool) else "string"}
            return self.syntax.literal(literal, type_ref)
        if kind == "field":
            value = fields.get(".".join(expr["path"]))
            return self.value(value, roots_) if value else "null"
        if kind == "unary":
            operand = self._expression(expr["operand"], fields, roots_, 8)
            return syntax.not_(operand) if expr["operator"] == "!" else f"-{operand}"
        if kind == "binary":
            precedence = _PRECEDENCE[expr["operator"]]
            left = self._expression(expr["left"], fields, roots_, precedence)
            right = self._expression(expr["right"], fields, roots_, precedence + 1)
            code = syntax.binary(expr["operator"], left, right)
            return f"({code})" if precedence < parent else code
        if kind == "conditional":
            code = syntax.conditional(
                self._expression(expr["condition"], fields, roots_, 1),
                self._expression(expr["then"], fields, roots_, 1),
                self._expression(expr["otherwise"], fields, roots_, 1),
            )
            return f"({code})" if parent > 0 else code
        return syntax.call(expr["name"], [self._expression(arg, fields, roots_, 0) for arg in expr["args"]])


def enum_value_name(enum_def: dict, name: str) -> str:
    """Enum value names as written in code: the name, unless only the wire value is known."""
    found = next((value for value in enum_def["values"] if value["name"] == name), None)
    return found["name"] if found else name


def quote(text: str) -> str:
    """Escapes text for a double-quoted string literal (JSON rules, valid in most C-family languages)."""
    return json.dumps(text, ensure_ascii=False)


def indent(code: str, spaces: int = 2) -> str:
    """Indents every line of a block."""
    pad = " " * spaces
    return "\n".join(line if line == "" else pad + line for line in code.split("\n"))
