"""Saving and opening projects, exporting the target model and the opt-in to keep the work on this computer.
Mirrors web/src/components/ProjectBar.tsx."""

from pathlib import Path

from PySide6.QtWidgets import QCheckBox, QFileDialog, QFrame, QHBoxLayout, QLabel, QMessageBox, QPushButton

from .paths import in_downloads


class ProjectBar(QFrame):
    def __init__(self, i18n, session):
        super().__init__()
        self.setObjectName("pane")
        self._i18n = i18n
        self._session = session
        layout = QHBoxLayout(self)
        layout.setContentsMargins(14, 8, 14, 8)
        self.open_button = QPushButton()
        self.open_button.clicked.connect(lambda: self.open_project())
        self.save_button = QPushButton()
        self.save_button.clicked.connect(lambda: self.save_project())
        self.export_button = QPushButton()
        self.export_button.clicked.connect(lambda: self.export_target())
        for button in (self.open_button, self.save_button, self.export_button):
            layout.addWidget(button)
        self.message = QLabel()
        self.message.setWordWrap(True)
        layout.addWidget(self.message, 1)
        self.remember = QCheckBox()
        self.remember.toggled.connect(session.set_remember)
        self.clear_button = QPushButton()
        self.clear_button.setProperty("small", True)
        self.clear_button.clicked.connect(self._clear_saved)
        layout.addWidget(self.remember)
        layout.addWidget(self.clear_button)
        i18n.changed.connect(self.refresh)
        for signal in (
            session.inputs_changed,
            session.mapping_changed,
            session.message_changed,
            session.output_changed,
        ):
            signal.connect(self.refresh)
        self.refresh()

    def open_project(self, path: str | None = None) -> None:
        t = self._i18n.t
        session = self._session
        if path is None:
            path = QFileDialog.getOpenFileName(self, t.open_project, "", f"{t.project_files} (*.json)")[0]
        if not path:
            return
        file = Path(path)
        try:
            text = file.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError):
            session.set_message(t.file_error(file.name), "error")
            return
        read = session.read_project_file(text)
        if not read["ok"]:
            session.set_message(t.project_error(read["error"], read.get("path")), "error")
            return
        if session.has_work() and not self._confirm(t.confirm_replace):
            return
        session.apply_project(read["project"])
        session.set_message(t.project_loaded(file.name))

    def save_project(self, path: str | None = None) -> None:
        file = self._session.project_file()
        if not file:
            return
        text, name = file
        target = (
            path or QFileDialog.getSaveFileName(self, self._i18n.t.save_project, in_downloads(name), "JSON (*.json)")[0]
        )
        if target:
            Path(target).write_text(text, encoding="utf-8")
            self._session.set_message(self._i18n.t.saved(target))

    def export_target(self, path: str | None = None) -> None:
        file = self._session.target_model_file()
        if not file:
            return
        text, name = file
        target = (
            path
            or QFileDialog.getSaveFileName(
                self, self._i18n.t.export_target, in_downloads(name), f"{self._i18n.t.model_schema_files} (*.json)"
            )[0]
        )
        if target:
            Path(target).write_text(text, encoding="utf-8")
            self._session.set_message(self._i18n.t.saved(target))

    def _confirm(self, text: str) -> bool:
        return QMessageBox.question(self, "Mapper", text) == QMessageBox.StandardButton.Yes

    def _clear_saved(self) -> None:
        if self._confirm(self._i18n.t.clear_saved_confirm):
            self._session.clear_saved()
            self._session.set_message(self._i18n.t.saved_cleared)

    def refresh(self) -> None:
        t = self._i18n.t
        session = self._session
        self.open_button.setText(t.open_project)
        self.save_button.setText(t.save_project)
        self.save_button.setEnabled(session.current_project() is not None)
        self.export_button.setText(t.export_target)
        self.export_button.setToolTip(t.export_target_title)
        self.export_button.setEnabled(session.schema("target") is not None)
        self.remember.blockSignals(True)
        self.remember.setChecked(session.remember)
        self.remember.blockSignals(False)
        self.remember.setText(t.remember)
        self.remember.setToolTip(t.remember_hint)
        self.clear_button.setText(t.clear_saved)
        self.clear_button.setVisible(session.has_saved())
        message = session.message
        self.message.setText(message[0] if message else "")
        self.message.setProperty("role", "error" if message and message[1] == "error" else "success")
        self.message.style().unpolish(self.message)
        self.message.style().polish(self.message)
