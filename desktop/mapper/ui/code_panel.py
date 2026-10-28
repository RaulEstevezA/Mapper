"""Generated code: output language, style, field names and the language's options, file tabs, the things to
check, copy and save. Mirrors web/src/components/CodePanel.tsx."""

import zipfile
from pathlib import Path

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QFileDialog,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QTabBar,
)

from ..core.generate.generators import GENERATORS
from ..core.generate.types import option_value
from .code_view import CodeView
from .pane import Pane, section
from .paths import in_downloads
from .widgets import clear_layout

NAMINGS = ("auto", "keep", "convention")


class CodePanel(Pane):
    def __init__(self, i18n, session):
        super().__init__()
        self._i18n = i18n
        self._session = session
        self._file_index = 0
        self.last_saved: str | None = None
        self._saved_message: str | None = None

        self.language = QComboBox()
        for generator in GENERATORS:
            self.language.addItem(generator.label, generator.id)
        self.language.activated.connect(lambda _=0: self._choose_generator())
        self.header.addWidget(self.language)

        settings = section()
        self._grid = QGridLayout(settings)
        self._grid.setContentsMargins(14, 0, 14, 8)
        self._grid.setHorizontalSpacing(10)
        self._grid.setVerticalSpacing(6)
        self.body.addWidget(settings)

        self.tabs = QTabBar()
        self.tabs.setExpanding(False)
        self.tabs.currentChanged.connect(self._choose_file)
        tabs_holder = section()
        tabs_layout = QHBoxLayout(tabs_holder)
        tabs_layout.setContentsMargins(14, 0, 14, 0)
        tabs_layout.addWidget(self.tabs)
        tabs_layout.addStretch()
        self.body.addWidget(tabs_holder)

        self.code = CodeView("text", read_only=True)
        self.body.addWidget(self.code, 1)

        self.notes = QLabel()
        self.notes.setWordWrap(True)
        self.notes.setProperty("role", "muted")
        self.footer.addWidget(self.notes, 1)
        self.copy_button = QPushButton()
        self.copy_button.clicked.connect(self.copy)
        self.save_button = QPushButton()
        self.save_button.setProperty("primary", True)
        self.save_button.clicked.connect(lambda: self.save())
        self.footer.addWidget(self.copy_button)
        self.footer.addWidget(self.save_button)

        self._copied = QTimer(self)
        self._copied.setSingleShot(True)
        self._copied.setInterval(2000)
        self._copied.timeout.connect(self.refresh)

        i18n.changed.connect(self.refresh)
        session.output_changed.connect(self._output_changed)
        self.refresh()

    @property
    def files(self) -> list[dict]:
        output = self._session.output
        return output["files"] if output else []

    def _choose_generator(self) -> None:
        self._session.set_generator(self.language.currentData())

    def _choose_file(self, index: int) -> None:
        if index >= 0 and index != self._file_index:
            self._file_index = index
            self._show_code()

    def _output_changed(self) -> None:
        self._saved_message = None
        self.refresh()

    def _set_option(self, option_id: str, value: str) -> None:
        settings = self._session.settings
        self._session.set_settings(settings["mode"], settings["naming"], {**settings["options"], option_id: value})

    def copy(self) -> None:
        files = self.files
        if files:
            QApplication.clipboard().setText(files[min(self._file_index, len(files) - 1)]["code"])
            self.copy_button.setText(self._i18n.t.copied)
            self._copied.start()

    def save(self, path: str | None = None) -> None:
        """Saves the file, or a .zip with every file. path skips the dialog (tests)."""
        files = self.files
        if not files:
            return
        t = self._i18n.t
        if len(files) == 1:
            target = path or QFileDialog.getSaveFileName(self, t.save, in_downloads(files[0]["name"]))[0]
            if target:
                Path(target).write_text(files[0]["code"], encoding="utf-8")
        else:
            default = f"mapper-{self._session.generator.id}.zip"
            target = path or QFileDialog.getSaveFileName(self, t.save, in_downloads(default), "ZIP (*.zip)")[0]
            if target:
                with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
                    for file in files:
                        archive.writestr(file["name"], file["code"])
        if target:
            self.last_saved = target
            self._saved_message = t.saved(target)
            self.refresh()

    def _show_code(self) -> None:
        files = self.files
        if files:
            file = files[min(self._file_index, len(files) - 1)]
            self.code.set_text_keeping_position(file["code"])
        else:
            self.code.setPlainText("")

    def refresh(self) -> None:
        t = self._i18n.t
        session = self._session
        generator = session.generator
        settings = session.settings
        self.title.setText(t.code_title)
        self.language.setCurrentIndex(max(0, self.language.findData(generator.id)))
        self.code.setPlaceholderText(t.code_empty)
        self.code.set_language(generator.editor_language)

        clear_layout(self._grid)
        row = 0

        def add(label_text: str, widget) -> None:
            nonlocal row
            label = QLabel(label_text)
            label.setProperty("role", "fieldLabel")
            self._grid.addWidget(label, row // 2, (row % 2) * 2)
            self._grid.addWidget(widget, row // 2, (row % 2) * 2 + 1)
            row += 1

        if len(generator.modes) > 1:
            mode = QComboBox()
            for item in generator.modes:
                mode.addItem(t.modes.get(item, item), item)
            mode.setCurrentIndex(max(0, mode.findData(settings["mode"])))
            mode.activated.connect(
                lambda _=0, mode=mode: session.set_settings(mode.currentData(), settings["naming"], settings["options"])
            )
            add(t.code_mode, mode)
        naming = QComboBox()
        for item in NAMINGS:
            naming.addItem(t.namings[item], item)
        naming.setCurrentIndex(max(0, naming.findData(settings["naming"])))
        naming.activated.connect(
            lambda _=0, naming=naming: session.set_settings(settings["mode"], naming.currentData(), settings["options"])
        )
        add(t.naming_label, naming)
        for option in generator.options:
            if option.id == "componentModel" and settings["mode"] != "mapstruct":
                continue
            value = option_value(generator, session.plan, settings, option.id)
            if option.kind == "text":
                widget = QLineEdit(value)
                widget.editingFinished.connect(
                    lambda option_id=option.id, widget=widget: (
                        self._set_option(option_id, widget.text())
                        if widget.text() != option_value(generator, session.plan, session.settings, option_id)
                        else None
                    )
                )
            else:
                widget = QComboBox()
                for choice in option.choices:
                    widget.addItem(t.choice_labels.get(choice, choice), choice)
                widget.setCurrentIndex(max(0, widget.findData(value)))
                widget.activated.connect(
                    lambda _=0, option_id=option.id, widget=widget: self._set_option(option_id, widget.currentData())
                )
            add(t.option_labels.get(option.id, option.id), widget)

        files = self.files
        self.tabs.blockSignals(True)
        while self.tabs.count():
            self.tabs.removeTab(0)
        if len(files) > 1:
            for file in files:
                self.tabs.addTab(file["name"])
            self._file_index = min(self._file_index, len(files) - 1)
            self.tabs.setCurrentIndex(self._file_index)
        else:
            self._file_index = 0
        self.tabs.setVisible(len(files) > 1)
        self.tabs.blockSignals(False)
        self._show_code()

        output = session.output
        notes = output["notes"] if output else []
        lines = []
        if files:
            lines.append(files[min(self._file_index, len(files) - 1)]["name"])
        if notes:
            lines.append(t.notes_count(len(notes)))
            lines.extend(f"· {t.note(note)}" for note in notes[:6])
        if self._saved_message:
            lines.append(self._saved_message)
        self.notes.setText("\n".join(lines))
        self.copy_button.setText(t.copied if self._copied.isActive() else t.copy)
        self.copy_button.setEnabled(bool(files))
        self.save_button.setText(t.save_zip(len(files)) if len(files) > 1 else t.save)
        self.save_button.setEnabled(bool(files))
