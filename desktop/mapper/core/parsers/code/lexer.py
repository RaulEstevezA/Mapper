"""A small configurable tokenizer for the declaration languages Mapper reads (code, GraphQL, Protocol
Buffers, Prisma). Mirrors web/src/core/parsers/code/lexer.ts. It never runs anything: it only splits the
text into identifiers, numbers, strings and punctuation, skipping comments, so the parsers can look for
declarations."""

import re
import unicodedata
from dataclasses import dataclass

from ...js import trim


class Token:
    __slots__ = ("kind", "value", "start", "end", "line", "column", "line_start", "doc", "doc_raw")

    def __init__(self, kind: str, value: str, start: int, end: int, line: int, column: int, line_start: bool):
        # ident, number, string or punct
        self.kind = kind
        # For strings, the content without quotes (escapes resolved); otherwise the text as written
        self.value = value
        self.start = start
        self.end = end
        self.line = line
        self.column = column
        # First token of its line (for indentation-based languages and line-based declarations)
        self.line_start = line_start
        # Comment right before the token, without the comment markers: the documentation of a declaration
        self.doc: str | None = None
        # The same comment with its markers and tags (@type {string}), for JSDoc
        self.doc_raw: str | None = None

    def __repr__(self) -> str:
        return f"Token({self.kind}, {self.value!r}, line {self.line})"


@dataclass(frozen=True)
class StringRule:
    open: str
    close: str
    # Backslash escapes (\") are allowed
    escapes: bool
    multiline: bool


@dataclass(frozen=True)
class LexerConfig:
    line_comments: tuple[str, ...] = ()
    block_comments: tuple[tuple[str, str], ...] = ()
    # Block comments nest (Swift, Rust, Kotlin, Dart)
    nested_comments: bool = False
    # Longest delimiters first
    strings: tuple[StringRule, ...] = ()
    # Letters that may start a string (r"…", f'…', @"…", b"…"), skipped before matching a rule
    string_prefixes: re.Pattern | None = None
    # Characters allowed in identifiers besides letters, digits and _ ($ in JavaScript and PHP)
    identifier_chars: str = ""
    # Rust raw strings r#"…"#
    raw_hash_strings: bool = False
    # #[…] is an attribute even though # starts a comment (PHP 8)
    hash_attributes: bool = False


class LexError(Exception):
    def __init__(self, code: str, index: int):
        super().__init__(code)
        # unterminatedString or unterminatedComment
        self.code = code
        self.index = index


# Punctuation read as one token: arrows, scopes, nullable markers, spreads
MULTI_PUNCT = ("...", "?.", "??", "::", "->", "=>", "?:", "!!", "==", "!=", "<=", ">=", "&&", "||", "#[")

C_STRINGS = (StringRule('"', '"', True, False), StringRule("'", "'", True, False))
C_LIKE = LexerConfig(line_comments=("//",), block_comments=(("/*", "*/"),), strings=C_STRINGS)


def _is_letter(char: str) -> bool:
    if char < "\x80":
        return char.isalpha()
    return unicodedata.category(char)[0] == "L"


def _is_ident_start(char: str, extra: str) -> bool:
    return char == "_" or _is_letter(char) or (bool(extra) and char in extra)


def _is_ident_part(char: str, extra: str) -> bool:
    if char < "\x80":
        return char.isalnum() or char == "_" or (bool(extra) and char in extra)
    return unicodedata.category(char)[0] in "LN" or (bool(extra) and char in extra)


_DOC_START = re.compile(r'^\s*(/\*\*?|\*/|\*|///?|#+|""")\s?')
_DOC_END = re.compile(r"\*/\s*$")
_XML_DOC = re.compile(r"</?(summary|remarks|value|returns|para|c|code|see|seealso|param|example)\b[^>]*>", re.ASCII)
_NUMBER = re.compile(
    r"(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?|\.[0-9]+([eE][+-]?[0-9]+)?)[a-zA-Z]*"
)
_RAW_HASH = re.compile(r'r(#*)"')
_RAW_PREFIX = re.compile(r"[@rR]")


def clean_doc(raw: str) -> str:
    lines = [trim(_DOC_END.sub("", _DOC_START.sub("", line, count=1), count=1)) for line in raw.split("\n")]
    joined = " ".join(line for line in lines if line != "" and not line.startswith("@"))
    # C# XML documentation: <summary>, <remarks>, <see cref="…"/>…
    return trim(_XML_DOC.sub("", joined))


def tokenize(text: str, config: LexerConfig) -> list[Token]:
    tokens: list[Token] = []
    extra = config.identifier_chars
    length = len(text)
    state = {"index": 0, "line": 1, "line_start_index": 0, "at_line_start": True, "pending": None}

    def advance_to(target: int) -> None:
        index = state["index"]
        while index < target:
            if text[index] == "\n":
                state["line"] += 1
                state["line_start_index"] = index + 1
                state["at_line_start"] = True
            index += 1
        state["index"] = index

    def push(kind: str, value: str, start: int, end: int) -> None:
        line = state["line"]
        token = Token(kind, value, start, end, line, start - state["line_start_index"] + 1, state["at_line_start"])
        pending = state["pending"]
        # Documentation only counts when the comment ends on the line right before (or the same line)
        if pending and pending[2] >= line - 1:
            if pending[0]:
                token.doc = pending[0]
            token.doc_raw = pending[1]
        state["pending"] = None
        tokens.append(token)
        state["at_line_start"] = False

    def read_string(rule: StringRule, start: int, content_start: int) -> None:
        cursor = content_start
        value: list[str] = []
        while True:
            if cursor >= length:
                raise LexError("unterminatedString", start)
            if text.startswith(rule.close, cursor):
                break
            char = text[cursor]
            if char == "\n" and not rule.multiline:
                raise LexError("unterminatedString", start)
            if char == "\\" and rule.escapes and cursor + 1 < length:
                following = text[cursor + 1]
                value.append("\n" if following == "n" else "\t" if following == "t" else following)
                cursor += 2
                continue
            value.append(char)
            cursor += 1
        end = cursor + len(rule.close)
        push("string", "".join(value), start, end)
        advance_to(end)

    while state["index"] < length:
        index = state["index"]
        char = text[index]
        if char in "\n \t\r\f﻿":
            advance_to(index + 1)
            continue

        line_comment = next(
            (
                marker
                for marker in config.line_comments
                if text.startswith(marker, index)
                and not (config.hash_attributes and marker == "#" and text[index + 1 : index + 2] == "[")
            ),
            None,
        )
        if line_comment:
            end = text.find("\n", index)
            stop = length if end == -1 else end
            comment_line = state["line"]
            raw = text[index:stop]
            content = clean_doc(raw)
            pending = state["pending"]
            state["pending"] = (
                (trim(f"{pending[0]} {content}"), f"{pending[1]}\n{raw}", comment_line)
                if pending and pending[2] == comment_line - 1
                else (content, raw, comment_line)
            )
            advance_to(stop)
            continue

        block = next((item for item in config.block_comments if text.startswith(item[0], index)), None)
        if block:
            open_mark, close_mark = block
            depth = 1
            cursor = index + len(open_mark)
            while depth > 0:
                if cursor >= length:
                    raise LexError("unterminatedComment", index)
                if config.nested_comments and text.startswith(open_mark, cursor):
                    depth += 1
                    cursor += len(open_mark)
                elif text.startswith(close_mark, cursor):
                    depth -= 1
                    cursor += len(close_mark)
                else:
                    cursor += 1
            raw = text[index:cursor]
            advance_to(cursor)
            state["pending"] = (clean_doc(raw), raw, state["line"])
            continue

        # Rust raw strings: r"…", r#"…"#
        if config.raw_hash_strings and char == "r" and _RAW_HASH.match(text[index : index + 10]):
            hashes = _RAW_HASH.match(text, index).group(1)
            read_string(StringRule(f'r{hashes}"', f'"{hashes}', False, True), index, index + len(hashes) + 2)
            continue

        # String prefixes (r, b, f, @, $): only when a quote follows right away
        prefix_length = 0
        if config.string_prefixes:
            match = config.string_prefixes.match(text[index : index + 4])
            if match and any(text.startswith(rule.open, index + len(match.group(0))) for rule in config.strings):
                prefix_length = len(match.group(0))
        rule = next((item for item in config.strings if text.startswith(item.open, index + prefix_length)), None)
        if rule:
            # A verbatim C# string (@"…") or raw Python string (r"…") has no escapes
            raw_string = bool(_RAW_PREFIX.search(text[index : index + prefix_length]))
            chosen = StringRule(rule.open, rule.close, False, rule.multiline) if raw_string else rule
            read_string(chosen, index, index + prefix_length + len(rule.open))
            continue

        if _is_ident_start(char, extra):
            end = index + 1
            while end < length and _is_ident_part(text[end], extra):
                end += 1
            push("ident", text[index:end], index, end)
            advance_to(end)
            continue

        if "0" <= char <= "9" or (char == "." and "0" <= text[index + 1 : index + 2] <= "9"):
            match = _NUMBER.match(text, index)
            end = match.end()
            push("number", match.group(0), index, end)
            advance_to(end)
            continue

        multi = next((item for item in MULTI_PUNCT if text.startswith(item, index)), None)
        value = multi or char
        push("punct", value, index, index + len(value))
        advance_to(index + len(value))
    return tokens


# #[ opens a Rust or PHP attribute and closes with ]
OPEN = {"(": ")", "[": "]", "{": "}", "#[": "]"}


class Cursor:
    """Reading position over the tokens, with the helpers every declaration parser needs."""

    def __init__(self, tokens: list[Token]):
        self.tokens = tokens
        self.index = 0

    @property
    def done(self) -> bool:
        return self.index >= len(self.tokens)

    def peek(self, offset: int = 0) -> Token | None:
        position = self.index + offset
        return self.tokens[position] if 0 <= position < len(self.tokens) else None

    def value(self, offset: int = 0) -> str:
        """The value of a token ahead, or '' at the end: comparisons need no None checks."""
        token = self.peek(offset)
        return token.value if token else ""

    def is_(self, value: str, offset: int = 0) -> bool:
        token = self.peek(offset)
        return token is not None and token.kind != "string" and token.value == value

    def is_ident(self, offset: int = 0) -> bool:
        token = self.peek(offset)
        return token is not None and token.kind == "ident"

    def next(self) -> Token:
        """The current token, moving past it. At the end of the input it returns an empty token, so a parser
        reading a truncated declaration never fails on a missing token."""
        token = self.tokens[self.index] if self.index < len(self.tokens) else self._end_token()
        self.index = min(self.index + 1, len(self.tokens))
        return token

    def _end_token(self) -> Token:
        last = self.tokens[-1] if self.tokens else None
        end = last.end if last else 0
        return Token("punct", "", end, end, last.line if last else 1, (last.column if last else 0) + 1, False)

    def eat(self, value: str) -> bool:
        if self.is_(value):
            self.index += 1
            return True
        return False

    def skip_group(self) -> None:
        """Skips a balanced group starting at the current (, [ or { (all bracket kinds are tracked)."""
        if self.value() not in OPEN:
            self.index += 1
            return
        stack: list[str] = []
        while not self.done:
            token = self.next()
            if token.kind != "punct":
                continue
            if token.value in OPEN:
                stack.append(OPEN[token.value])
            elif stack and token.value == stack[-1]:
                stack.pop()
                if not stack:
                    return

    def text_between(self, source: str, start: int, stop: int) -> str:
        """Text of the source between two token indexes, for raw annotation arguments and default values."""
        if start >= stop:
            return ""
        return source[self.tokens[start].start : self.tokens[stop - 1].end]

    def skip_until(self, values, stop_at_close: bool = True) -> None:
        """Skips to just after the next token with one of these values at the current nesting level."""
        depth = 0
        while not self.done:
            token = self.tokens[self.index]
            if token.kind == "punct":
                if depth == 0 and token.value in values:
                    return
                if token.value in OPEN:
                    depth += 1
                elif token.value in (")", "]", "}"):
                    if depth == 0 and stop_at_close:
                        return
                    depth -= 1
            self.index += 1
