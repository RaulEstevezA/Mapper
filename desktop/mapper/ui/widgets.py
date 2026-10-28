"""Small widgets shared by the panels: badges with a state as text (never color alone) and helpers."""

from PySide6.QtWidgets import QComboBox, QLabel, QLayout, QPushButton, QWidget

_TONES = {
    "exact": "success",
    "high": "success",
    "probable": "accent",
    "review": "warning",
    "conflict": "warning",
    "none": "",
    "manual": "accent",
    "ignored": "",
}


def badge(text: str, tone: str = "") -> QLabel:
    label = QLabel(text)
    label.setProperty("role", "badge")
    if tone:
        label.setProperty("tone", tone)
    return label


def confidence_badge(t, confidence: str, score: float | None = None, tooltip: str = "") -> QLabel:
    """State of a relation as text with a color (patterns/confidence-states.md). The score is shown for suggestions
    that are not certain."""
    label = t.status[confidence]
    if score is not None and confidence in ("probable", "review"):
        label = t.status_with_score(label, score)
    widget = badge(label, _TONES.get(confidence, ""))
    if tooltip:
        widget.setToolTip(tooltip)
    return widget


def small_button(text: str, primary: bool = False) -> QPushButton:
    button = QPushButton(text)
    button.setProperty("small", True)
    if primary:
        button.setProperty("primary", True)
    return button


def muted(text: str, wrap: bool = True) -> QLabel:
    label = QLabel(text)
    label.setProperty("role", "muted")
    label.setWordWrap(wrap)
    return label


def mono(text: str) -> QLabel:
    label = QLabel(text)
    label.setProperty("role", "mono")
    return label


def combo(items: list[tuple[str, object]], current=None) -> QComboBox:
    widget = QComboBox()
    for text, data in items:
        widget.addItem(text, data)
    index = widget.findData(current)
    widget.setCurrentIndex(max(0, index))
    return widget


def clear_layout(layout: QLayout) -> None:
    """Removes and deletes every item of a layout, nested layouts included."""
    while layout.count():
        item = layout.takeAt(0)
        widget: QWidget | None = item.widget()
        if widget is not None:
            # Hidden now and deleted by Qt later, while it still has its parent
            widget.hide()
            widget.deleteLater()
        elif item.layout() is not None:
            clear_layout(item.layout())
