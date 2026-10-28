"""The relations: one section per pair of models, a row per target field with its source, transformation and
state, the unused source fields and the checks. The relation being edited opens below the list. Mirrors
web/src/components/MappingPanel.tsx."""

import json

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QButtonGroup,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLayout,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from ..core.mapping.edit import accept_all_reviews, accept_candidate, restore_suggestions, toggle_ignored_source
from ..core.mapping.paths import resolve_path
from ..core.mapping.types import path_key
from ..core.mapping.validate import summarize_diagnostics
from ..core.model.compatibility import compatibility
from ..core.model.schema import all_fields, describe_type, find_model, needs_value
from ..core.workspace import category_of, matches_filter, reachable
from .field_editor import FieldEditor
from .pane import Pane, section
from .widgets import badge, clear_layout, confidence_badge, mono, muted, small_button

FILTERS = ("all", "review", "unmapped", "mapped", "warnings")


class MappingPanel(Pane):
    def __init__(self, i18n, session):
        super().__init__()
        self._i18n = i18n
        self._session = session
        self._filter = "all"
        self._search = ""
        # (mapping id, target field) of the relation being edited
        self._open: tuple[str, str] | None = None

        self.accept_button = QPushButton()
        self.accept_button.setProperty("primary", True)
        self.accept_button.clicked.connect(self._accept_all)
        self.undo_button = QPushButton()
        self.undo_button.clicked.connect(session.undo)
        self.redo_button = QPushButton()
        self.redo_button.clicked.connect(session.redo)
        self.restore_button = QPushButton()
        self.restore_button.clicked.connect(self._restore)
        toolbar = section()
        toolbar_layout = QVBoxLayout(toolbar)
        toolbar_layout.setContentsMargins(14, 0, 14, 8)
        # Buttons on their own row, so the title and the buttons are never cut
        actions = QHBoxLayout()
        for button in (self.accept_button, self.undo_button, self.redo_button, self.restore_button):
            button.setProperty("small", True)
            actions.addWidget(button)
        actions.addStretch()
        toolbar_layout.addLayout(actions)
        self.summary = QLabel()
        self.summary.setWordWrap(True)
        toolbar_layout.addWidget(self.summary)
        filters = QHBoxLayout()
        self._filter_group = QButtonGroup(self)
        self._filter_buttons = {}
        for filter_id in FILTERS:
            button = small_button("")
            button.setCheckable(True)
            button.setProperty("toggle", True)
            button.clicked.connect(lambda _=False, filter_id=filter_id: self._set_filter(filter_id))
            self._filter_group.addButton(button)
            filters.addWidget(button)
            self._filter_buttons[filter_id] = button
        self._filter_buttons["all"].setChecked(True)
        filters.addStretch()
        toolbar_layout.addLayout(filters)
        self.search = QLineEdit()
        self.search.textChanged.connect(self._set_search)
        toolbar_layout.addWidget(self.search)
        self.body.addWidget(toolbar)

        self._splitter = QSplitter(Qt.Orientation.Vertical)
        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)
        self._content = QWidget()
        self._content.setProperty("section", "pane")
        self._rows = QVBoxLayout(self._content)
        self._rows.setContentsMargins(14, 4, 14, 14)
        self._rows.setSpacing(6)
        # The rows keep their height and the list scrolls, instead of squeezing them
        self._rows.setSizeConstraint(QLayout.SizeConstraint.SetMinimumSize)
        self._scroll.setWidget(self._content)
        self._splitter.addWidget(self._scroll)
        self.editor = FieldEditor(i18n)
        self.editor.update_set.connect(session.push)
        self.editor.closed.connect(self._close_editor)
        editor_scroll = QScrollArea()
        editor_scroll.setWidgetResizable(True)
        editor_scroll.setWidget(self.editor)
        self._editor_scroll = editor_scroll
        self._splitter.addWidget(editor_scroll)
        self._splitter.setChildrenCollapsible(False)
        self._splitter.setSizes([3, 2])
        self.body.addWidget(self._splitter, 1)

        # The checks: a summary, always visible, and the list, shown on demand to keep room for the relations
        footer = QVBoxLayout()
        summary_row = QHBoxLayout()
        self.diagnostics = QLabel()
        self.diagnostics.setWordWrap(True)
        self.details_button = small_button("")
        self.details_button.setCheckable(True)
        self.details_button.setProperty("toggle", True)
        self.details_button.toggled.connect(self._toggle_details)
        summary_row.addWidget(self.diagnostics, 1)
        summary_row.addWidget(self.details_button)
        self.details = QLabel()
        self.details.setWordWrap(True)
        self.details.setProperty("role", "muted")
        footer.addLayout(summary_row)
        footer.addWidget(self.details)
        self.footer.addLayout(footer, 1)
        self._details_open: bool | None = None

        i18n.changed.connect(self.refresh)
        session.mapping_changed.connect(self.refresh)
        self.refresh()

    # Actions

    def _set_filter(self, filter_id: str) -> None:
        self._filter = filter_id
        self.refresh()

    def _set_search(self, text: str) -> None:
        self._search = text
        self.refresh()

    def _accept_all(self) -> None:
        session = self._session
        current = session.mapping
        for mapping in reachable(current):
            current = accept_all_reviews(current, mapping["id"])
        session.push(current)

    def _restore(self) -> None:
        session = self._session
        if not session.mapping:
            return
        answer = QMessageBox.question(self, "Mapper", self._i18n.t.restore_confirm)
        if answer == QMessageBox.StandardButton.Yes:
            mapping = session.mapping
            session.push(
                restore_suggestions(mapping, session.schema("source"), session.schema("target"), mapping["root"])
            )

    def open_field(self, mapping_id: str, target: str) -> None:
        self._open = None if self._open == (mapping_id, target) else (mapping_id, target)
        self.refresh()

    def _close_editor(self) -> None:
        self._open = None
        self.refresh()

    def _toggle_details(self, checked: bool) -> None:
        self._details_open = checked
        self.details.setVisible(checked)

    # Display

    def refresh(self) -> None:
        t = self._i18n.t
        session = self._session
        mapping_set = session.mapping
        source, target = session.schema("source"), session.schema("target")
        self.title.setText(t.mapping_title)
        self.undo_button.setText(t.undo)
        self.undo_button.setToolTip(t.undo_title)
        self.redo_button.setText(t.redo)
        self.redo_button.setToolTip(t.redo_title)
        self.restore_button.setText(t.restore_suggestions)
        self.search.setPlaceholderText(t.search_placeholder)
        for filter_id, button in self._filter_buttons.items():
            button.setText(t.filters[filter_id])
        clear_layout(self._rows)

        ready = bool(mapping_set and source and target)
        for widget in (self.accept_button, self.undo_button, self.redo_button, self.restore_button, self.search):
            widget.setVisible(ready)
        for button in self._filter_buttons.values():
            button.setVisible(ready)
        self.summary.setVisible(ready)
        if not ready:
            self._open = None
            self._editor_scroll.hide()
            if source is None and target is None:
                waiting = t.mapping_empty
            elif source is None:
                waiting = t.mapping_waiting("source")
            elif target is None:
                waiting = t.mapping_waiting("target")
            else:
                waiting = t.mapping_empty
            self._rows.addWidget(muted(waiting))
            self._rows.addStretch()
            self.diagnostics.setText("")
            self.details.hide()
            self.details_button.hide()
            return

        diagnostics = session.diagnostics
        mappings = reachable(mapping_set)
        summary = session.summary()
        parts = [t.summary["total"](summary["total"]), t.summary["mapped"](summary["mapped"])]
        for key in ("review", "conflict", "unmapped", "ignored"):
            if summary[key] > 0:
                parts.append(t.summary[key](summary[key]))
        self.summary.setText(" · ".join(parts))
        reviewable = sum(
            1
            for mapping in mappings
            for field in mapping["fields"]
            if field["status"] == "pending" and field["confidence"] != "conflict"
        )
        self.accept_button.setText(t.accept_reviews(reviewable))
        self.accept_button.setVisible(reviewable > 0)
        self.undo_button.setEnabled(session.can_undo)
        self.redo_button.setEnabled(session.can_redo)

        editing = None
        for mapping in mappings:
            target_model = find_model(target, mapping["target"])
            source_model = find_model(source, mapping["source"])
            if not target_model or not source_model:
                continue
            title = QLabel(t.nested(mapping["source"], mapping["target"]))
            title.setProperty("role", "sectionTitle")
            self._rows.addWidget(title)
            target_fields = all_fields(target, target_model)
            visible = [
                field
                for field in mapping["fields"]
                if matches_filter(field, self._filter, self._search, diagnostics, mapping["id"])
            ]
            if not visible:
                self._rows.addWidget(muted(t.no_results))
            for field in visible:
                target_field = next((item for item in target_fields if item["name"] == field["target"]), None)
                if not target_field:
                    continue
                is_open = self._open == (mapping["id"], field["target"])
                if is_open:
                    editing = (mapping, field)
                self._rows.addWidget(self._row(mapping, field, target_field, source, target, diagnostics, is_open))
            self._unused(mapping, diagnostics)

        self._rows.addStretch()
        if editing:
            self.editor.show_field(mapping_set, editing[0], editing[1], source, target, diagnostics)
            self._editor_scroll.show()
        else:
            self._open = None
            self._editor_scroll.hide()

        counts = summarize_diagnostics(diagnostics)
        shown = [item for item in diagnostics if item["severity"] != "info" or item["code"] != "unusedSource"]
        lines = []
        for item in shown[:8]:
            text = t.diagnostic(item["code"], item.get("target", ""), item.get("params"))
            model = f" ({item['mapping'].replace('->', ' → ')})" if item["mapping"] != mapping_set["root"] else ""
            lines.append(f"{t.severity[item['severity']]}: {text}{model}")
        if len(shown) > 8:
            lines.append("…")
        self.details.setText("\n".join(lines))
        self.details_button.setText(t.diagnostics_title)
        self.details_button.setVisible(bool(lines))
        self.details_button.blockSignals(True)
        self.details_button.setChecked(bool(self._details_open))
        self.details_button.blockSignals(False)
        self.details.setVisible(bool(lines) and self.details_button.isChecked())
        self.diagnostics.setText(
            f"{t.diagnostics_title}: {t.diagnostics_summary(counts['error'], counts['warning'], counts['info'])}"
        )
        tone = "error" if counts["error"] else "warning" if counts["warning"] else "success"
        self.diagnostics.setProperty("role", tone)
        self.diagnostics.style().unpolish(self.diagnostics)
        self.diagnostics.style().polish(self.diagnostics)

    def _source_text(self, field: dict) -> QWidget:
        t = self._i18n.t
        transform = field["transform"]
        if field["status"] == "ignored":
            return muted(t.no_source, False)
        if transform["kind"] == "constant":
            return mono(json.dumps(transform["value"], ensure_ascii=False))
        if transform["kind"] == "expression":
            return mono(transform["expression"])
        if not field["sources"]:
            return muted(t.no_source, False)
        text = " + ".join(f"({t.root})" if not path else path_key(path) for path in field["sources"])
        label = mono(text)
        label.setWordWrap(True)
        return label

    def _transform_text(self, mapping: dict, field: dict, source: dict, target: dict) -> str:
        t = self._i18n.t
        transform = field["transform"]
        if transform["kind"] != "direct":
            name = t.transform[transform["kind"]]
            summary = t.transform_summary(transform)
            return f"{name} · {summary}" if summary and summary != name.lower() else name
        # A direct relation that converts the type says so: "string → integer"
        resolved = resolve_path(source, mapping["source"], field["sources"][0]) if field["sources"] else None
        target_model = find_model(target, mapping["target"])
        target_field = (
            next((item for item in all_fields(target, target_model) if item["name"] == field["target"]), None)
            if target_model
            else None
        )
        if resolved and target_field and compatibility(resolved["type"], target_field["type"])["level"] != "same":
            return t.conversion_hint(describe_type(resolved["type"]), describe_type(target_field["type"]))
        return ""

    def _status(self, field: dict) -> QLabel:
        t = self._i18n.t
        if field["status"] == "ignored":
            return confidence_badge(t, "ignored")
        if field["status"] == "active" and field.get("manual"):
            return confidence_badge(t, "manual")
        candidates = field.get("candidates") or []
        score = candidates[0]["score"] if candidates else None
        reasons = " ".join(t.reason(reason) for reason in field.get("reasons") or [])
        confidence = "none" if field["status"] == "unmapped" else field["confidence"]
        return confidence_badge(t, confidence, score, reasons)

    def _row(self, mapping, field, target_field, source, target, diagnostics, is_open: bool) -> QFrame:
        t = self._i18n.t
        row = QFrame()
        row.setObjectName("row")
        row.setProperty("category", category_of(field))
        row.setProperty("open", is_open)
        layout = QVBoxLayout(row)
        layout.setContentsMargins(10, 6, 10, 6)
        layout.setSpacing(4)
        line = QHBoxLayout()
        line.addWidget(mono(field["target"]))
        line.addWidget(muted(describe_type(target_field["type"]), False))
        if target_field["nullable"]:
            line.addWidget(badge("null"))
        if needs_value(target_field) and field["status"] != "active":
            line.addWidget(badge(t.required_badge, "danger"))
        line.addStretch()
        line.addWidget(self._status(field))
        if field["status"] == "pending" and field["confidence"] != "conflict":
            accept = small_button(t.accept)
            accept.clicked.connect(
                lambda _=False: self._session.push(
                    accept_candidate(self._session.mapping, mapping["id"], field["target"])
                )
            )
            line.addWidget(accept)
        edit = small_button(t.close if is_open else t.edit)
        edit.clicked.connect(lambda _=False: self.open_field(mapping["id"], field["target"]))
        line.addWidget(edit)
        layout.addLayout(line)
        # Where the value comes from, and how
        origin = QHBoxLayout()
        arrow = QLabel("←")
        arrow.setProperty("role", "muted")
        origin.addWidget(arrow)
        source_widget = self._source_text(field)
        source_widget.setWordWrap(True)
        origin.addWidget(source_widget, 1)
        layout.addLayout(origin)
        transform = self._transform_text(mapping, field, source, target)
        if transform:
            layout.addWidget(muted(transform))
        issues = [
            item
            for item in diagnostics
            if item["mapping"] == mapping["id"]
            and item.get("target") == field["target"]
            and item["severity"] != "info"
            and item["code"] not in ("pendingSuggestion", "conflictPending")
        ]
        for issue in issues:
            label = QLabel(
                f"{t.severity[issue['severity']]}: {t.diagnostic(issue['code'], field['target'], issue.get('params'))}"
            )
            label.setWordWrap(True)
            label.setProperty("role", "error" if issue["severity"] == "error" else "warning")
            layout.addWidget(label)
        return row

    def _unused(self, mapping: dict, diagnostics: list) -> None:
        t = self._i18n.t
        unused = [
            str((item.get("params") or {}).get("field"))
            for item in diagnostics
            if item["mapping"] == mapping["id"] and item["code"] == "unusedSource"
        ]
        ignored = mapping["ignoredSources"]
        if not unused and not ignored:
            return
        box = QFrame()
        box.setObjectName("row")
        layout = QVBoxLayout(box)
        layout.setContentsMargins(10, 6, 10, 6)
        title = QLabel(t.unused_title(len(unused)))
        title.setProperty("role", "fieldLabel")
        layout.addWidget(title)
        layout.addWidget(muted(t.unused_hint))
        for name in [*unused, *ignored]:
            line = QHBoxLayout()
            line.addWidget(mono(name))
            if name in ignored:
                line.addWidget(badge(t.ignored_source))
            line.addStretch()
            toggle = small_button(t.unmark_ignored if name in ignored else t.mark_ignored)
            toggle.clicked.connect(
                lambda _=False, name=name: self._session.push(
                    toggle_ignored_source(self._session.mapping, mapping["id"], name.split("."))
                )
            )
            line.addWidget(toggle)
            layout.addLayout(line)
        self._rows.addWidget(box)
