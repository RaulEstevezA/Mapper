"""Plain text editor with line numbers, syntax highlighting and an optional highlighted error line."""

from PySide6.QtCore import QRect, QSize, Qt
from PySide6.QtGui import QColor, QPainter, QTextCursor, QTextFormat
from PySide6.QtWidgets import QPlainTextEdit, QTextEdit, QWidget

from .highlighter import Highlighter, monospace_font
from .theme import DANGER, MUTED, PAGE_BG


class _LineNumbers(QWidget):
    def __init__(self, editor: "CodeView"):
        super().__init__(editor)
        self._editor = editor

    def sizeHint(self) -> QSize:  # noqa: N802 (Qt's name)
        return QSize(self._editor.line_number_width(), 0)

    def paintEvent(self, event) -> None:  # noqa: N802 (Qt's name)
        self._editor.paint_line_numbers(event)


class CodeView(QPlainTextEdit):
    def __init__(self, language: str = "text", read_only: bool = False):
        super().__init__()
        self.setFont(monospace_font())
        self.setReadOnly(read_only)
        self.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        self.setTabStopDistance(self.fontMetrics().horizontalAdvance(" ") * 2)
        self.highlighter = Highlighter(self.document(), language)
        self._numbers = _LineNumbers(self)
        self.blockCountChanged.connect(self._update_margin)
        self.updateRequest.connect(self._update_numbers)
        self._update_margin()

    def set_language(self, language: str) -> None:
        self.highlighter.set_language(language)

    def set_text_keeping_position(self, text: str) -> None:
        """Replaces the text without moving the view to the top when it is the same file regenerated."""
        if text == self.toPlainText():
            return
        scroll = self.verticalScrollBar().value()
        self.setPlainText(text)
        self.verticalScrollBar().setValue(scroll)

    def highlight_error_line(self, line: int | None) -> None:
        if line is None:
            self.setExtraSelections([])
            return
        selection = QTextEdit.ExtraSelection()
        color = QColor(DANGER)
        color.setAlpha(40)
        selection.format.setBackground(color)
        selection.format.setProperty(QTextFormat.Property.FullWidthSelection, True)
        cursor = QTextCursor(self.document().findBlockByNumber(line - 1))
        selection.cursor = cursor
        self.setExtraSelections([selection])

    def line_number_width(self) -> int:
        digits = len(str(max(1, self.blockCount())))
        return 14 + self.fontMetrics().horizontalAdvance("9") * digits

    def _update_margin(self, *_args) -> None:
        self.setViewportMargins(self.line_number_width(), 0, 0, 0)

    def _update_numbers(self, rect: QRect, dy: int) -> None:
        if dy:
            self._numbers.scroll(0, dy)
        else:
            self._numbers.update(0, rect.y(), self._numbers.width(), rect.height())
        if rect.contains(self.viewport().rect()):
            self._update_margin()

    def resizeEvent(self, event) -> None:  # noqa: N802 (Qt's name)
        super().resizeEvent(event)
        area = self.contentsRect()
        self._numbers.setGeometry(QRect(area.left(), area.top(), self.line_number_width(), area.height()))

    def paint_line_numbers(self, event) -> None:
        painter = QPainter(self._numbers)
        painter.fillRect(event.rect(), QColor(PAGE_BG))
        painter.setPen(QColor(MUTED))
        block = self.firstVisibleBlock()
        number = block.blockNumber()
        top = round(self.blockBoundingGeometry(block).translated(self.contentOffset()).top())
        bottom = top + round(self.blockBoundingRect(block).height())
        height = self.fontMetrics().height()
        while block.isValid() and top <= event.rect().bottom():
            if block.isVisible() and bottom >= event.rect().top():
                painter.drawText(
                    0, top, self._numbers.width() - 6, height, Qt.AlignmentFlag.AlignRight, str(number + 1)
                )
            block = block.next()
            top = bottom
            bottom = top + round(self.blockBoundingRect(block).height())
            number += 1
