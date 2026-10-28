"""Syntax highlighting with the same colors as the web editors, adapted from Api2Class. Simple per-line rules:
enough to read models and generated code, not a full parser."""

from PySide6.QtCore import QRegularExpression
from PySide6.QtGui import QColor, QFont, QSyntaxHighlighter, QTextCharFormat, QTextDocument

from .theme import SYNTAX

_KEYWORDS = {
    "python": "from import class def return if else for in is not None True False and or with as pass self cls lambda",
    "java": "import package public private protected class record static final void return new this if else extends "
    "interface enum switch case default throw",
    "typescript": "import export from interface type const let return new if else extends class enum function switch "
    "case default throw readonly",
    "javascript": "import export from const let return new if else extends class function switch case default throw",
    "csharp": "using namespace public private class record get set init required new return if else static switch "
    "throw this enum",
    "kotlin": "import package data class val var fun return if else object null when enum private",
    "dart": "import part class final const factory required return if null this abstract with extension on switch enum",
    "swift": "import struct class enum case let var func init return if else self try extension switch default",
    "go": "package import type struct func return if else var for range map const",
    "php": "declare final class public private readonly function static return new fn if null self match enum "
    "namespace use",
    "rust": "use pub struct enum impl fn let mut return if else match for Self self",
    "scala": "import final case class derives val def object extends sealed trait enum",
    "graphql": "type input interface enum scalar extend implements schema query mutation",
    "protobuf": "syntax package import message enum repeated optional map oneof service rpc returns",
    "prisma": "model enum datasource generator type view",
    "smithy": "namespace structure list map member union",
}

_LINE_COMMENT = {"python": "#", "yaml": "#", "graphql": "#", "json": None, "xml": None, "text": None}

_CONSTANTS = r"\b(true|false|null|nil|None|True|False)\b"


def _format(color: str, italic: bool = False) -> QTextCharFormat:
    text_format = QTextCharFormat()
    text_format.setForeground(QColor(color))
    if italic:
        text_format.setFontItalic(True)
    return text_format


class Highlighter(QSyntaxHighlighter):
    def __init__(self, document: QTextDocument, language: str = "text"):
        super().__init__(document)
        self._rules: list[tuple[QRegularExpression, QTextCharFormat, int]] = []
        self.set_language(language)

    def set_language(self, language: str) -> None:
        rules: list[tuple[str, QTextCharFormat, int]] = []
        if language == "text":
            pass
        elif language == "json":
            rules.append((_CONSTANTS, _format(SYNTAX["constant"]), 0))
            rules.append((r"-?\b\d+(\.\d+)?([eE][+-]?\d+)?\b", _format(SYNTAX["constant"]), 0))
            rules.append((r'"(\\.|[^"\\])*"', _format(SYNTAX["string"]), 0))
            # Keys: a string followed by a colon
            rules.append((r'("(\\.|[^"\\])*")\s*:', _format(SYNTAX["property"]), 1))
        elif language == "yaml":
            rules.append((_CONSTANTS, _format(SYNTAX["constant"]), 0))
            rules.append((r"-?\b\d+(\.\d+)?\b", _format(SYNTAX["constant"]), 0))
            rules.append((r"^\s*(- )?([\w\"' .-]+):", _format(SYNTAX["property"]), 2))
            rules.append((r'"(\\.|[^"\\])*"', _format(SYNTAX["string"]), 0))
            rules.append((r"#.*$", _format(SYNTAX["comment"], italic=True), 0))
        elif language == "xml":
            rules.append((r"</?[\w:.-]+", _format(SYNTAX["keyword"]), 0))
            rules.append((r"\b[\w:-]+(?==)", _format(SYNTAX["property"]), 0))
            rules.append((r'"[^"]*"', _format(SYNTAX["string"]), 0))
            rules.append((r"<!--.*-->", _format(SYNTAX["comment"], italic=True), 0))
        else:
            rules.append((r"\b[A-Z][A-Za-z0-9_]*\b", _format(SYNTAX["type"]), 0))
            words = _KEYWORDS.get(language, "")
            if words:
                rules.append((rf"\b({'|'.join(words.split())})\b", _format(SYNTAX["keyword"]), 0))
            rules.append((_CONSTANTS, _format(SYNTAX["constant"]), 0))
            rules.append((r"\b\d+(\.\d+)?\b", _format(SYNTAX["constant"]), 0))
            rules.append((r"[@#]\[?[A-Za-z_][\w.]*", _format(SYNTAX["function"]), 0))
            rules.append((r'"(\\.|[^"\\])*"', _format(SYNTAX["string"]), 0))
            rules.append((r"'(\\.|[^'\\])*'", _format(SYNTAX["string"]), 0))
            comment = _LINE_COMMENT.get(language, "//")
            if comment:
                rules.append((rf"{QRegularExpression.escape(comment)}.*$", _format(SYNTAX["comment"], italic=True), 0))
        self._rules = [(QRegularExpression(pattern), text_format, group) for pattern, text_format, group in rules]
        self.rehighlight()

    def highlightBlock(self, text: str) -> None:  # noqa: N802 (Qt's name)
        for pattern, text_format, group in self._rules:
            matches = pattern.globalMatch(text)
            while matches.hasNext():
                match = matches.next()
                self.setFormat(match.capturedStart(group), match.capturedLength(group), text_format)


def monospace_font() -> QFont:
    font = QFont()
    font.setFamilies(["SF Mono", "Menlo", "Consolas", "DejaVu Sans Mono", "monospace"])
    font.setStyleHint(QFont.StyleHint.Monospace)
    font.setPointSize(12)
    return font
