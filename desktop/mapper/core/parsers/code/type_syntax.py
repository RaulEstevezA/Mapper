"""How a language writes types, and a reader for them. Mirrors web/src/core/parsers/code/typeSyntax.ts."""

from collections.abc import Callable
from dataclasses import dataclass

from ...js import json_string
from .lexer import Cursor
from .raw import RawType, raw


@dataclass(frozen=True)
class TypeSyntax:
    """Every option is off by default."""

    # Brackets of generic arguments: List<String> or list[str]
    generics: str = "<>"
    # String[], int[][]
    array_suffix: bool = False
    # String?, and Swift's String!
    nullable_suffix: bool = False
    # ?string (PHP)
    nullable_prefix: bool = False
    # string | null, A | B
    unions: bool = False
    # *User (Go): a pointer may be nil
    pointers: bool = False
    # [String] and [String: Int] (Swift)
    bracket_collections: bool = False
    # []string and map[string]int (Go)
    go_collections: bool = False
    # Reference and lifetime markers to skip (&'a str in Rust)
    references: bool = False
    # Qualified names joined by these separators: java.util.List, App\\Models\\User, std::vec::Vec
    separators: tuple[str, ...] = (".",)
    # Reads a type the common syntax does not know (TypeScript object literal types); None to fall through
    custom: Callable[[Cursor], RawType | None] | None = None
    # A & B (TypeScript): read as a union-like & node
    intersections: bool = False


def _read_name(cursor: Cursor, syntax: TypeSyntax) -> str | None:
    separators = syntax.separators
    name = ""
    # A leading separator: \\DateTime in PHP, ::std::string
    for separator in separators:
        if cursor.is_(separator) and separator != ".":
            cursor.next()
            name = separator
    if not cursor.is_ident():
        return None if name == "" else name
    name += cursor.next().value
    while True:
        separator = next((item for item in separators if cursor.is_(item)), None)
        if separator and cursor.is_ident(1):
            cursor.next()
            name += separator + cursor.next().value
            continue
        return name


def _read_arguments(cursor: Cursor, syntax: TypeSyntax, close: str) -> list[RawType]:
    args: list[RawType] = []
    while not cursor.done and not cursor.is_(close):
        arg = read_type(cursor, syntax)
        if arg:
            args.append(arg)
        elif not cursor.is_(close) and not cursor.is_(","):
            cursor.next()
        if not cursor.eat(","):
            break
    # >> is read as two > tokens by the lexer, so a simple match is enough
    cursor.eat(close)
    return args


def _with_nullable(type_ref: RawType) -> RawType:
    return {**type_ref, "nullable": True}


def _read_single(cursor: Cursor, syntax: TypeSyntax) -> RawType | None:
    if syntax.references:
        while (
            cursor.is_("&")
            or cursor.is_("mut")
            or cursor.is_("dyn")
            or cursor.is_("impl")
            or (cursor.is_("'") and cursor.is_ident(1))
        ):
            if cursor.is_("'"):
                cursor.next()
            cursor.next()

    nullable = False
    if syntax.nullable_prefix and cursor.eat("?"):
        nullable = True
    if syntax.pointers:
        while cursor.eat("*"):
            nullable = True

    type_ref: RawType | None = None
    if syntax.go_collections and cursor.is_("["):
        # []T, or [N]T for a fixed-size array
        cursor.next()
        while not cursor.done and not cursor.is_("]"):
            cursor.next()
        cursor.eat("]")
        items = _read_single(cursor, syntax)
        type_ref = raw("[]", [items] if items else [])
    elif syntax.go_collections and cursor.is_("map") and cursor.is_("[", 1):
        cursor.next()
        cursor.next()
        key = read_type(cursor, syntax)
        cursor.eat("]")
        value = _read_single(cursor, syntax)
        type_ref = raw("{}", [key or raw("string"), value or raw("any")])
    elif syntax.bracket_collections and cursor.is_("["):
        cursor.next()
        first = read_type(cursor, syntax)
        if cursor.eat(":"):
            value = read_type(cursor, syntax)
            cursor.eat("]")
            type_ref = raw("{}", [first or raw("Any"), value or raw("Any")])
        else:
            cursor.eat("]")
            type_ref = raw("[]", [first] if first else [])
    elif syntax.custom and (custom := syntax.custom(cursor)):
        # Read by the language itself
        type_ref = custom
    elif cursor.is_("("):
        # A parenthesized type ((string | null)[]); tuples and function types are of unknown shape
        start = cursor.index
        cursor.next()
        inner = read_type(cursor, syntax)
        if inner and cursor.eat(")") and not cursor.is_("=>") and not cursor.is_("->"):
            type_ref = inner
        else:
            cursor.index = start
            cursor.skip_group()
            if cursor.eat("=>") or cursor.eat("->"):
                read_type(cursor, syntax)
            type_ref = raw("any")
    elif cursor.peek() is not None and cursor.peek().kind in ("string", "number"):
        # Literal types ('active' | 'inactive'), turned into enums by the parsers that support them
        token = cursor.next()
        type_ref = raw(json_string(token.value) if token.kind == "string" else token.value)
    else:
        name = _read_name(cursor, syntax)
        if name is None:
            return None
        open_mark, close_mark = ("<", ">") if syntax.generics == "<>" else ("[", "]")
        args: list[RawType] = []
        if cursor.is_(open_mark) and not (syntax.array_suffix and open_mark == "[" and cursor.is_("]", 1)):
            cursor.next()
            args = _read_arguments(cursor, syntax, close_mark)
        type_ref = raw(name, args)

    while True:
        if syntax.array_suffix and cursor.is_("[") and cursor.is_("]", 1):
            cursor.next()
            cursor.next()
            type_ref = raw("[]", [type_ref])
            continue
        if syntax.nullable_suffix and (cursor.is_("?") or cursor.is_("!")):
            # ! is Swift's implicitly unwrapped optional, but not Kotlin's !! operator
            cursor.next()
            type_ref = _with_nullable(type_ref)
            continue
        break
    if nullable:
        type_ref = _with_nullable(type_ref)
    return type_ref


def read_type(cursor: Cursor, syntax: TypeSyntax) -> RawType | None:
    """Reads a type at the cursor, or returns None (and moves nothing) when there is none."""
    # A leading | or & is allowed in TypeScript (type A =\n  | 'x'\n  | 'y')
    if syntax.unions and (cursor.is_("|") or (syntax.intersections and cursor.is_("&"))):
        cursor.next()
    first = _read_intersection(cursor, syntax)
    if not first or not syntax.unions or not cursor.is_("|"):
        return first
    options = [first]
    while cursor.eat("|"):
        option = _read_intersection(cursor, syntax)
        if option:
            options.append(option)
    return raw("|", options)


def _read_intersection(cursor: Cursor, syntax: TypeSyntax) -> RawType | None:
    first = _read_single(cursor, syntax)
    if not first or not syntax.intersections or not cursor.is_("&"):
        return first
    parts = [first]
    while cursor.eat("&"):
        part = _read_single(cursor, syntax)
        if part:
            parts.append(part)
    return raw("&", parts)
