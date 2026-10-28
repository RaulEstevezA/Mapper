"""Mapper's expression language for custom transformations. Mirrors web/src/core/transform/expression.ts.

It is deliberately small: literals, source fields, arithmetic, comparisons, ??, a conditional and a closed
list of functions. It is parsed into a tree and checked here, then translated by each generator; it is never
evaluated, so no user text is ever run (docs/transformations.md).

Nodes are dictionaries: {"kind": "literal", "value"}, {"kind": "field", "path"}, {"kind": "unary", "operator",
"operand"}, {"kind": "binary", "operator", "left", "right"}, {"kind": "conditional", "condition", "then",
"otherwise"}, {"kind": "call", "name", "args"}. Value kinds: string, number, boolean, null, any.
"""

import math
import re
import unicodedata

from ..js import WHITESPACE, number, trim

# Every function the language has: argument kinds (the last one may repeat) and result kind
FUNCTIONS = {
    "upper": {"args": ["string"], "result": "string"},
    "lower": {"args": ["string"], "result": "string"},
    "trim": {"args": ["string"], "result": "string"},
    "length": {"args": ["string"], "result": "number"},
    "concat": {"args": ["any", "any"], "result": "string", "variadic": True},
    "substring": {"args": ["string", "number", "number"], "result": "string", "optional": 1},
    "replace": {"args": ["string", "string", "string"], "result": "string"},
    "round": {"args": ["number"], "result": "number"},
    "floor": {"args": ["number"], "result": "number"},
    "ceil": {"args": ["number"], "result": "number"},
    "abs": {"args": ["number"], "result": "number"},
    "min": {"args": ["number", "number"], "result": "number"},
    "max": {"args": ["number", "number"], "result": "number"},
    "toString": {"args": ["any"], "result": "string"},
    "toNumber": {"args": ["string"], "result": "number"},
}

_OPERATORS = (
    "??",
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||",
    "+",
    "-",
    "*",
    "/",
    "%",
    "<",
    ">",
    "!",
    "(",
    ")",
    ",",
    ".",
    "?",
    ":",
)
# Limits that keep generated code readable and the parser safe from pathological input
MAX_LENGTH = 2000
MAX_DEPTH = 40

_NUMBER = re.compile(r"[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?", re.IGNORECASE)

# Binding power of binary operators: higher binds tighter
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


class _ParseError(Exception):
    def __init__(self, error: dict):
        super().__init__(error["code"])
        self.error = error


def _error(code: str, column: int, params: dict | None = None) -> _ParseError:
    error = {"code": code, "column": column}
    if params:
        error["params"] = params
    return _ParseError(error)


def _is_name_start(char: str) -> bool:
    return char in "_$" or unicodedata.category(char)[0] == "L"


def _is_name_part(char: str) -> bool:
    return char in "_$" or unicodedata.category(char)[0] in "LN"


def _tokenize(text: str) -> list[dict]:
    tokens: list[dict] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char in WHITESPACE:
            index += 1
            continue
        column = index + 1
        if "0" <= char <= "9" or (char == "." and "0" <= text[index + 1 : index + 2] <= "9" and index + 1 < len(text)):
            match = _NUMBER.match(text, index)
            tokens.append({"type": "number", "text": match.group(0), "value": number(match.group(0)), "column": column})
            index = match.end()
            continue
        if char in ('"', "'"):
            value: list[str] = []
            cursor = index + 1
            while True:
                if cursor >= len(text):
                    raise _error("unterminatedString", column)
                current = text[cursor]
                if current == char:
                    break
                if current == "\\" and cursor + 1 < len(text):
                    following = text[cursor + 1]
                    value.append("\n" if following == "n" else "\t" if following == "t" else following)
                    cursor += 2
                    continue
                value.append(current)
                cursor += 1
            tokens.append(
                {"type": "string", "text": text[index : cursor + 1], "value": "".join(value), "column": column}
            )
            index = cursor + 1
            continue
        if _is_name_start(char):
            end = index + 1
            while end < len(text) and _is_name_part(text[end]):
                end += 1
            tokens.append({"type": "name", "text": text[index:end], "column": column})
            index = end
            continue
        operator = next((item for item in _OPERATORS if text.startswith(item, index)), None)
        if not operator:
            raise _error("unexpectedToken", column, {"found": char})
        tokens.append({"type": "operator", "text": operator, "column": column})
        index += len(operator)
    tokens.append({"type": "end", "text": "", "column": len(text) + 1})
    return tokens


class _Parser:
    def __init__(self, tokens: list[dict]):
        self.tokens = tokens
        self.index = 0
        self.depth = 0

    def peek(self) -> dict:
        return self.tokens[self.index]

    def next(self) -> dict:
        token = self.tokens[self.index]
        self.index += 1
        return token

    def is_operator(self, text: str) -> bool:
        token = self.peek()
        return token["type"] == "operator" and token["text"] == text

    def expect(self, text: str) -> None:
        token = self.next()
        if token["text"] != text or token["type"] == "string":
            raise _error("unexpectedToken", token["column"], {"found": token["text"] or "end", "expected": text})

    def parse(self) -> dict:
        expr = self.expression()
        token = self.peek()
        if token["type"] != "end":
            raise _error("unexpectedToken", token["column"], {"found": token["text"]})
        return expr

    def expression(self) -> dict:
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise _error("tooComplex", self.peek()["column"])
        condition = self.binary(1)
        result = condition
        if self.is_operator("?"):
            self.next()
            then = self.expression()
            self.expect(":")
            otherwise = self.expression()
            result = {"kind": "conditional", "condition": condition, "then": then, "otherwise": otherwise}
        self.depth -= 1
        return result

    def binary(self, minimum: int) -> dict:
        left = self.unary()
        while True:
            token = self.peek()
            precedence = _PRECEDENCE.get(token["text"]) if token["type"] == "operator" else None
            if precedence is None or precedence < minimum:
                return left
            self.next()
            right = self.binary(precedence + 1)
            left = {"kind": "binary", "operator": token["text"], "left": left, "right": right}

    def unary(self) -> dict:
        token = self.peek()
        if token["type"] == "operator" and token["text"] in ("-", "!"):
            self.next()
            self.depth += 1
            if self.depth > MAX_DEPTH:
                raise _error("tooComplex", token["column"])
            operand = self.unary()
            self.depth -= 1
            # -5 is a literal, so generated code reads naturally
            if token["text"] == "-" and operand["kind"] == "literal" and _is_number(operand["value"]):
                return {"kind": "literal", "value": -operand["value"]}
            return {"kind": "unary", "operator": token["text"], "operand": operand}
        return self.primary()

    def primary(self) -> dict:
        token = self.next()
        if token["type"] in ("number", "string"):
            return {"kind": "literal", "value": token["value"]}
        if token["type"] == "operator" and token["text"] == "(":
            inner = self.expression()
            self.expect(")")
            return inner
        if token["type"] == "name":
            if token["text"] in ("true", "false"):
                return {"kind": "literal", "value": token["text"] == "true"}
            if token["text"] == "null":
                return {"kind": "literal", "value": None}
            if self.is_operator("("):
                definition = FUNCTIONS.get(token["text"])
                if definition is None:
                    raise _error("unknownFunction", token["column"], {"name": token["text"]})
                self.next()
                args: list[dict] = []
                if self.peek()["text"] != ")":
                    while True:
                        args.append(self.expression())
                        if not self.is_operator(","):
                            break
                        self.next()
                self.expect(")")
                minimum = len(definition["args"]) - definition.get("optional", 0)
                maximum = math.inf if definition.get("variadic") else len(definition["args"])
                if len(args) < minimum or len(args) > maximum:
                    raise _error("argumentCount", token["column"], {"name": token["text"], "count": minimum})
                return {"kind": "call", "name": token["text"], "args": args}
            # source.address.city and address.city name the same field
            path = [] if token["text"] == "source" and self.peek()["text"] == "." else [token["text"]]
            while self.is_operator("."):
                self.next()
                part = self.next()
                if part["type"] != "name":
                    raise _error("unexpectedToken", part["column"], {"found": part["text"] or "end"})
                path.append(part["text"])
            return {"kind": "field", "path": path}
        raise _error("unexpectedToken", token["column"], {"found": token["text"] or "end"})


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def expression_fields(expr: dict) -> list[list[str]]:
    """Fields an expression reads, without repetitions, in order of appearance."""
    fields: list[list[str]] = []

    def visit(node: dict) -> None:
        kind = node["kind"]
        if kind == "field":
            if not any(".".join(path) == ".".join(node["path"]) for path in fields):
                fields.append(node["path"])
        elif kind == "unary":
            visit(node["operand"])
        elif kind == "binary":
            visit(node["left"])
            visit(node["right"])
        elif kind == "conditional":
            visit(node["condition"])
            visit(node["then"])
            visit(node["otherwise"])
        elif kind == "call":
            for arg in node["args"]:
                visit(arg)

    visit(expr)
    return fields


def parse_expression(text: str) -> dict:
    """{"ok": True, "expr", "fields"} or {"ok": False, "error": {"code", "column", "params"?}}."""
    if trim(text) == "":
        return {"ok": False, "error": {"code": "empty", "column": 1}}
    if len(text) > MAX_LENGTH:
        return {"ok": False, "error": {"code": "tooComplex", "column": MAX_LENGTH}}
    try:
        expr = _Parser(_tokenize(text)).parse()
    except _ParseError as error:
        return {"ok": False, "error": error.error}
    return {"ok": True, "expr": expr, "fields": expression_fields(expr)}


def check_expression(expr: dict, field_kind) -> dict:
    """Kind of the value of an expression, given the kind of each field: {"kind"} or {"error"}. Reports the first
    type error."""

    def fail(code: str, params: dict | None = None):
        raise _error(code, 1, params)

    def compatible(actual: str, expected: str) -> bool:
        return expected == "any" or actual == "any" or actual == expected or actual == "null"

    def kind_of(node: dict) -> str:
        kind = node["kind"]
        if kind == "literal":
            value = node["value"]
            if value is None:
                return "null"
            if isinstance(value, bool):
                return "boolean"
            return "number" if _is_number(value) else "string"
        if kind == "field":
            found = field_kind(node["path"])
            if found is None:
                fail("unknownField", {"field": ".".join(node["path"])})
            return found
        if kind == "unary":
            operand = kind_of(node["operand"])
            expected = "number" if node["operator"] == "-" else "boolean"
            if not compatible(operand, expected):
                fail("typeMismatch", {"operator": node["operator"], "expected": expected, "found": operand})
            return expected
        if kind == "binary":
            left = kind_of(node["left"])
            right = kind_of(node["right"])
            operator = node["operator"]
            if operator == "??":
                return right if left == "null" else left
            if operator in ("&&", "||"):
                for side in (left, right):
                    if not compatible(side, "boolean"):
                        fail("typeMismatch", {"operator": operator, "expected": "boolean", "found": side})
                return "boolean"
            if operator in ("==", "!="):
                return "boolean"
            if operator == "+" and "string" in (left, right):
                # Joining text: both sides must be text, use concat() to join other values
                for side in (left, right):
                    if not compatible(side, "string"):
                        fail("typeMismatch", {"operator": "+", "expected": "string", "found": side})
                return "string"
            for side in (left, right):
                if not compatible(side, "number"):
                    fail("typeMismatch", {"operator": operator, "expected": "number", "found": side})
            return "boolean" if operator in ("<", "<=", ">", ">=") else "number"
        if kind == "conditional":
            condition = kind_of(node["condition"])
            if not compatible(condition, "boolean"):
                fail("typeMismatch", {"operator": "?", "expected": "boolean", "found": condition})
            then = kind_of(node["then"])
            otherwise = kind_of(node["otherwise"])
            if then == otherwise:
                return then
            return otherwise if then == "null" else then if otherwise == "null" else "any"
        definition = FUNCTIONS[node["name"]]
        for index, arg in enumerate(node["args"]):
            expected = definition["args"][min(index, len(definition["args"]) - 1)]
            actual = kind_of(arg)
            if not compatible(actual, expected):
                fail("typeMismatch", {"operator": node["name"], "expected": expected, "found": actual})
        return definition["result"]

    try:
        return {"kind": kind_of(expr)}
    except _ParseError as error:
        return {"error": error.error}
