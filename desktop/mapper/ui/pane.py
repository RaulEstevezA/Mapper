"""One of the three workspace columns: a title bar with actions, a body and a footer."""

from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QVBoxLayout, QWidget


class Pane(QFrame):
    def __init__(self):
        super().__init__()
        self.setObjectName("pane")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        header = section()
        self.header = QHBoxLayout(header)
        self.header.setContentsMargins(16, 12, 12, 12)
        self.title = QLabel()
        self.title.setProperty("role", "paneTitle")
        self.header.addWidget(self.title)
        self.header.addStretch()
        layout.addWidget(header)
        self.body = QVBoxLayout()
        self.body.setContentsMargins(0, 0, 0, 0)
        self.body.setSpacing(0)
        layout.addLayout(self.body, 1)
        footer = section()
        self.footer = QHBoxLayout(footer)
        self.footer.setContentsMargins(14, 8, 10, 8)
        layout.addWidget(footer)


def section(kind: str = "pane") -> QWidget:
    """Container with the pane's background (or the field editor's), without changing its children."""
    widget = QWidget()
    widget.setProperty("section", kind)
    return widget
