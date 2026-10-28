"""Source or target input: editor, open, clear, create (target), format and model, and the reading status.
Mirrors web/src/components/InputPane.tsx and CreateTarget.tsx."""

from pathlib import Path

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import QComboBox, QFileDialog, QFrame, QHBoxLayout, QLabel, QPushButton, QVBoxLayout

from ..core.generate.models import DRAFT_FORMATS
from ..core.js import trim
from ..core.parsers.registry import PARSERS, accepted_extensions, detect_format, find_parser
from .code_view import CodeView
from .i18n import I18n
from .pane import Pane, section
from .session import Session

# Far above any model or example document; avoids freezing the window with a huge file opened by mistake
MAX_FILE_SIZE = 10 * 1024 * 1024


class InputEditor(CodeView):
    """Editor that opens files dropped on it instead of inserting their path."""

    file_dropped = Signal(str)

    def dragEnterEvent(self, event) -> None:  # noqa: N802 (Qt's name)
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            super().dragEnterEvent(event)

    def dragMoveEvent(self, event) -> None:  # noqa: N802 (Qt's name)
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            super().dragMoveEvent(event)

    def dropEvent(self, event) -> None:  # noqa: N802 (Qt's name)
        urls = event.mimeData().urls()
        if urls and urls[0].isLocalFile():
            event.acceptProposedAction()
            self.file_dropped.emit(urls[0].toLocalFile())
        else:
            super().dropEvent(event)


class CreateTarget(QFrame):
    """Form inside the Target panel to write a new target model from the source (forms stay in the window, not in
    a dialog, as in the web version)."""

    def __init__(self, i18n: I18n):
        super().__init__()
        self.setObjectName("editorBox")
        self._i18n = i18n
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 10, 12, 10)
        self.title = QLabel()
        self.title.setProperty("role", "sectionTitle")
        self.description = QLabel()
        self.description.setWordWrap(True)
        self.description.setProperty("role", "muted")
        row = QHBoxLayout()
        self.format_label = QLabel()
        self.format_label.setProperty("role", "fieldLabel")
        self.format = QComboBox()
        for format_id in DRAFT_FORMATS:
            parser = find_parser(format_id)
            self.format.addItem(parser.label if parser else format_id, format_id)
        self.cancel = QPushButton()
        self.confirm = QPushButton()
        self.confirm.setProperty("primary", True)
        row.addWidget(self.format_label)
        row.addWidget(self.format, 1)
        row.addWidget(self.cancel)
        row.addWidget(self.confirm)
        self.warning = QLabel()
        self.warning.setProperty("role", "warning")
        for widget in (self.title, self.description):
            layout.addWidget(widget)
        layout.addLayout(row)
        layout.addWidget(self.warning)

    def show_for(self, source_model: str, replaces: bool) -> None:
        t = self._i18n.t
        self.title.setText(t.create_title)
        self.description.setText(t.create_description(source_model))
        self.format_label.setText(t.create_format)
        self.cancel.setText(t.cancel)
        self.confirm.setText(t.create_confirm)
        self.warning.setText(t.create_replace)
        self.warning.setVisible(replaces)
        self.show()


class InputPane(Pane):
    def __init__(self, role: str, i18n: I18n, session: Session):
        super().__init__()
        self.role = role
        self._i18n = i18n
        self._session = session
        self._file_error: str | None = None
        self._updating = False

        self.open_button = QPushButton()
        self.open_button.clicked.connect(self.choose_file)
        self.clear_button = QPushButton()
        self.clear_button.clicked.connect(self._clear)
        for button in (self.open_button, self.clear_button):
            self.header.addWidget(button)
        self.create_button = None
        if role == "target":
            self.create_button = QPushButton()
            self.create_button.clicked.connect(self._toggle_create)
            self.header.addWidget(self.create_button)

        self.create_form = CreateTarget(i18n)
        self.create_form.hide()
        self.create_form.cancel.clicked.connect(self.create_form.hide)
        self.create_form.confirm.clicked.connect(self._create)
        if role == "target":
            holder = section()
            holder_layout = QVBoxLayout(holder)
            holder_layout.setContentsMargins(12, 0, 12, 8)
            holder_layout.addWidget(self.create_form)
            self.body.addWidget(holder)

        settings = section()
        row = QHBoxLayout(settings)
        row.setContentsMargins(14, 0, 14, 10)
        self.format_label = QLabel()
        self.format_label.setProperty("role", "fieldLabel")
        self.format = QComboBox()
        self.format.currentIndexChanged.connect(self._format_chosen)
        self.model_label = QLabel()
        self.model_label.setProperty("role", "fieldLabel")
        self.model = QComboBox()
        self.model.currentIndexChanged.connect(self._model_chosen)
        row.addWidget(self.format_label)
        row.addWidget(self.format, 1)
        row.addWidget(self.model_label)
        row.addWidget(self.model, 1)
        self.body.addWidget(settings)

        self.editor = InputEditor("text")
        self.editor.file_dropped.connect(self.open_file)
        self.editor.textChanged.connect(self._typed)
        self.body.addWidget(self.editor, 1)
        self.status = QLabel()
        self.status.setWordWrap(True)
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        self.footer.addWidget(self.status, 1)

        # Large inputs are read once typing pauses, so the editor stays smooth
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setInterval(250)
        self._timer.timeout.connect(self._commit_text)

        i18n.changed.connect(self.refresh)
        session.inputs_changed.connect(self.refresh)
        self.refresh()

    # Actions

    def choose_file(self) -> None:
        t = self._i18n.t
        patterns = " ".join(f"*{extension}" for extension in accepted_extensions())
        path, _ = QFileDialog.getOpenFileName(
            self, t.open_dialog, "", f"{t.model_files} ({patterns});;{t.all_files} (*)"
        )
        if path:
            self.open_file(path)

    def open_file(self, path: str) -> None:
        """Read on this computer: the file is never sent anywhere."""
        t = self._i18n.t
        file = Path(path)
        try:
            if file.stat().st_size > MAX_FILE_SIZE:
                self._show_file_error(t.file_too_large(file.name))
                return
            text = file.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError):
            self._show_file_error(t.file_error(file.name))
            return
        self._file_error = None
        # A model another tool saved for Mapper fills the side it was meant for
        if self._session.receive(text):
            return
        self._session.set_input(self.role, {"text": text, "format": None, "model": None, "fileName": file.name})

    def set_text(self, text: str) -> None:
        self.editor.setPlainText(text)
        self._commit_text()

    def _show_file_error(self, text: str) -> None:
        self._file_error = text
        self.refresh()

    def _clear(self) -> None:
        self._file_error = None
        self._session.set_input(self.role, {"text": "", "format": None, "model": None})

    def _toggle_create(self) -> None:
        if self.create_form.isVisible():
            self.create_form.hide()
            return
        source_model = self._session.model("source") if self._session.schema("source") else None
        if source_model:
            self.create_form.show_for(source_model, trim(self._session.inputs["target"]["text"]) != "")

    def _create(self) -> None:
        source_model = self._session.model("source")
        model = self._session.create_target(self.create_form.format.currentData())
        self.create_form.hide()
        if model:
            self._session.set_message(self._i18n.t.created(model, source_model))

    def _typed(self) -> None:
        if not self._updating:
            self._file_error = None
            self._timer.start()

    def _commit_text(self) -> None:
        self._timer.stop()
        text = self.editor.toPlainText()
        if text != self._session.inputs[self.role]["text"]:
            self._session.change_input(self.role, text=text, receivedFrom=None)

    def _format_chosen(self) -> None:
        if not self._updating:
            self._commit_text()
            self._session.change_input(self.role, format=self.format.currentData(), model=None)

    def _model_chosen(self) -> None:
        if not self._updating and self.model.currentData():
            self._session.change_input(self.role, model=self.model.currentData())

    # Display

    def refresh(self) -> None:
        t = self._i18n.t
        session = self._session
        state = session.inputs[self.role]
        read = session.reads[self.role]
        self._updating = True
        self.title.setText(t.source_title if self.role == "source" else t.target_title)
        self.open_button.setText(t.open_file)
        self.clear_button.setText(t.clear)
        self.clear_button.setEnabled(state["text"] != "")
        if self.create_button:
            self.create_button.setText(t.create)
            can_create = session.schema("source") is not None and session.model("source") is not None
            self.create_button.setEnabled(can_create)
            self.create_button.setToolTip("" if can_create else t.create_unavailable)
            if not can_create:
                self.create_form.hide()
        self.format_label.setText(t.format_label)
        self.model_label.setText(t.model_label)
        self.editor.setPlaceholderText(t.input_placeholder)
        # Text being typed is not replaced: it reaches the session once typing pauses
        if self.editor.toPlainText() != state["text"] and not self._timer.isActive():
            self.editor.setPlainText(state["text"])

        detected = detect_format(state["text"], state.get("fileName")) if trim(state["text"]) else None
        detected_parser = find_parser(detected) if detected else None
        self.format.clear()
        self.format.addItem(t.format_auto(detected_parser.label if detected_parser else detected), None)
        for parser in PARSERS:
            self.format.addItem(parser.label, parser.id)
        self.format.setCurrentIndex(max(0, self.format.findData(state["format"])) if state["format"] else 0)

        outcome = read["outcome"]
        models = outcome["schema"]["models"] if outcome and outcome["ok"] else []
        self.model.clear()
        for model in models:
            self.model.addItem(f"{model['name']} ({len(model['fields'])})", model["name"])
        self.model.setCurrentIndex(max(0, self.model.findData(read["model"])))
        self.model.setVisible(len(models) > 1)
        self.model_label.setVisible(len(models) > 1)

        parser = find_parser(read["format"]) if read["format"] else None
        self.editor.set_language(parser.editor_language if parser else "text")
        error_line = None
        if self._file_error:
            text, role = self._file_error, "error"
        elif trim(state["text"]) == "":
            text, role = t.input_empty, "muted"
        elif not read["format"]:
            text, role = t.undetected, "warning"
        elif outcome and not outcome["ok"]:
            error = outcome["error"]
            prefix = f"{t.error_position(error['line'], error.get('column', 1))} · " if "line" in error else ""
            text, role = prefix + t.parse_issue(error), "error"
            error_line = error.get("line")
        elif outcome:
            fields = sum(len(model["fields"]) for model in models)
            text = t.input_summary(parser.label if parser else read["format"], len(models), fields)
            if state.get("receivedFrom"):
                text = f"{t.received_from(state['receivedFrom'])} {text}"
            warnings = outcome["warnings"]
            if warnings:
                text += f" · {t.warnings_count(len(warnings))}"
            self.status.setToolTip("\n".join(t.parse_issue(warning) for warning in warnings))
            role = "success"
        else:
            text, role = "", "muted"
        self.editor.highlight_error_line(error_line)
        self.status.setText(text)
        self.status.setProperty("role", role)
        self.status.style().unpolish(self.status)
        self.status.style().polish(self.status)
        self._updating = False
