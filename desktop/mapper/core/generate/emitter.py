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


def make_expression_syntax(
    binary, not_, conditional, call, length_bits: int = 32, one_number_type: bool = False
) -> SimpleNamespace:
    """conditional(condition, then, otherwise, type) gets the number type of both branches when they are numbers;
    call(name, args, types) the number type of each argument (None when it is not a number). length_bits: bits of
    the integer of text lengths and positions, length() and substring(). one_number_type: every number has the
    same type (JavaScript), so an expression needs no number conversions."""
    return SimpleNamespace(
        binary=binary,
        not_=not_,
        conditional=conditional,
        call=call,
        length_bits=length_bits,
        one_number_type=one_number_type,
    )


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

_INTEGER = {"kind": "primitive", "name": "integer"}
_FLOAT = {"kind": "primitive", "name": "float"}


def _is_integer(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] == "integer"


def _is_number_type(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("integer", "float", "decimal")


def _is_number_literal(expr: dict) -> bool:
    value = expr.get("value")
    return expr["kind"] == "literal" and isinstance(value, (int, float)) and not isinstance(value, bool)


def _same_number(a: dict, b: dict) -> bool:
    """Same number type: integers without a size are 64-bit."""
    if a["kind"] != "primitive" or b["kind"] != "primitive" or a["name"] != b["name"]:
        return a == b
    return a.get("bits", 64) == b.get("bits", 64) if a["name"] in ("integer", "float") else True


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
        target = value["type"]
        return self._typed(value["expr"], value["fields"], roots_, 0, target if _is_number_type(target) else None)

    def _number_type(self, expr: dict, fields: dict) -> dict | None:
        """Number type of an expression's value, None when it is not a number. Integers stay integers; / divides as
        real numbers, so it gives a float, like any operation with a float or a decimal."""
        kind = expr["kind"]
        if kind == "literal":
            if not _is_number_literal(expr):
                return None
            return _INTEGER if float(expr["value"]).is_integer() else _FLOAT
        if kind == "field":
            value = fields.get(".".join(expr["path"]))
            return value["type"] if value and _is_number_type(value["type"]) else None
        if kind == "unary":
            return self._number_type(expr["operand"], fields) if expr["operator"] == "-" else None
        if kind == "binary":
            operator = expr["operator"]
            if operator == "/":
                return _FLOAT
            if operator == "??":
                return self._common_type(expr["left"], expr["right"], fields, True)
            return (
                self._common_type(expr["left"], expr["right"], fields, False)
                if operator in ("+", "-", "*", "%")
                else None
            )
        if kind == "conditional":
            return self._common_type(expr["then"], expr["otherwise"], fields, True)
        name = expr["name"]
        if name in ("round", "floor", "ceil", "abs"):
            type_ref = self._number_type(expr["args"][0], fields)
            return type_ref if type_ref and _is_integer(type_ref) else _FLOAT
        if name in ("min", "max"):
            return self._common_type(expr["args"][0], expr["args"][1], fields, False)
        if name == "length":
            return self._text_integer()
        return _FLOAT if name == "toNumber" else None

    def _text_integer(self) -> dict:
        """The integer type of text lengths and positions (length, substring)."""
        return {"kind": "primitive", "name": "integer", "bits": self.syntax.expression.length_bits}

    def _common_type(self, a: dict, b: dict, fields: dict, keep_decimal: bool) -> dict | None:
        """The type two numbers are brought to before they meet: a number literal takes the other side's type when it
        fits, integers of different sizes meet as 64-bit integers and anything else as a float. A decimal only stays
        a decimal where no operator works on it (keep_decimal: conditional branches, ??)."""
        left = self._number_type(a, fields)
        right = self._number_type(b, fields)
        if not left or not right:
            return None

        def usable(type_ref: dict) -> bool:
            return keep_decimal or type_ref["kind"] != "primitive" or type_ref["name"] != "decimal"

        def fits(literal: dict, type_ref: dict) -> bool:
            return (
                _is_number_literal(literal)
                and usable(type_ref)
                and (not _is_integer(type_ref) or float(literal["value"]).is_integer())
            )

        if fits(b, left):
            return left
        if fits(a, right):
            return right
        if _same_number(left, right) and usable(left):
            return left
        return _INTEGER if _is_integer(left) and _is_integer(right) else _FLOAT

    def _typed(self, expr: dict, fields: dict, roots_: dict, parent: int, want: dict | None) -> str:
        """An expression whose value is brought to the number type want, when given: a number literal is written in
        that type, anything else is converted. Conditionals pass want on to their branches."""
        if not want or self.syntax.expression.one_number_type:
            return self._expression(expr, fields, roots_, parent, None)
        kind = expr["kind"]
        if kind in ("conditional", "unary") or (kind == "binary" and expr["operator"] == "??"):
            return self._expression(expr, fields, roots_, parent, want)
        type_ref = self._number_type(expr, fields)
        if not type_ref or _same_number(type_ref, want):
            return self._expression(expr, fields, roots_, parent, None)
        if _is_number_literal(expr):
            return self.syntax.literal(expr["value"], want)
        return self.syntax.convert(self._expression(expr, fields, roots_, 0, None), type_ref, want)

    def _expression(self, expr: dict, fields: dict, roots_: dict, parent: int, want: dict | None) -> str:
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
            if expr["operator"] == "!":
                return syntax.not_(self._expression(expr["operand"], fields, roots_, 8, None))
            return f"-{self._typed(expr['operand'], fields, roots_, 8, want)}"
        if kind == "binary":
            operator = expr["operator"]
            precedence = _PRECEDENCE[operator]
            # Both sides in the same number type: / always divides as real numbers
            if operator == "/":
                sides = _FLOAT
            elif operator == "??":
                sides = want or self._common_type(expr["left"], expr["right"], fields, True)
            elif operator in ("&&", "||"):
                sides = None
            else:
                sides = self._common_type(expr["left"], expr["right"], fields, False)
            left = self._typed(expr["left"], fields, roots_, precedence, sides)
            right = self._typed(expr["right"], fields, roots_, precedence + 1, sides)
            code = syntax.binary(operator, left, right)
            return f"({code})" if precedence < parent else code
        if kind == "conditional":
            type_ref = want or self._common_type(expr["then"], expr["otherwise"], fields, True)
            code = syntax.conditional(
                self._expression(expr["condition"], fields, roots_, 1, None),
                self._typed(expr["then"], fields, roots_, 1, type_ref),
                self._typed(expr["otherwise"], fields, roots_, 1, type_ref),
                None if syntax.one_number_type else type_ref,
            )
            return f"({code})" if parent > 0 else code
        name = expr["name"]
        args = expr["args"]
        wants: list[dict | None] = [None] * len(args)
        if name in ("round", "floor", "ceil", "abs"):
            type_ref = self._number_type(args[0], fields)
            # An integer is already whole
            if type_ref and _is_integer(type_ref):
                if name != "abs":
                    return self._expression(args[0], fields, roots_, parent, None)
            else:
                wants = [_FLOAT]
        elif name in ("min", "max"):
            type_ref = self._common_type(args[0], args[1], fields, False)
            wants = [type_ref, type_ref]
        elif name == "substring":
            wants = [None, self._text_integer(), self._text_integer()]
        types = [
            None if syntax.one_number_type else (wants[i] or self._number_type(arg, fields))
            for i, arg in enumerate(args)
        ]
        return syntax.call(name, [self._typed(arg, fields, roots_, 0, wants[i]) for i, arg in enumerate(args)], types)


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
