"""Editor of one relation: suggestions, transformation, source fields, its parameters, the value used when the
source is missing, and the actions. Mirrors web/src/components/FieldEditor.tsx. Texts are applied when the field
is left or Enter is pressed, so typing is never interrupted by the mapping being recomputed."""

import math

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QVBoxLayout,
    QWidget,
)

from ..core.js import js_string
from ..core.mapping.edit import (
    UNSET,
    accept_candidate,
    choose_sources,
    ignore_target,
    reset_field,
    set_expression,
    set_fallback,
    set_transform,
)
from ..core.mapping.paths import resolve_path
from ..core.mapping.types import path_key
from ..core.matching.engine import source_options, suggest_enum_pairs
from ..core.model.schema import all_fields, describe_type, find_enum, find_model
from .widgets import clear_layout, combo, confidence_badge, mono, muted, small_button


def _is_primitive(type_ref: dict | None, *names: str) -> bool:
    return bool(type_ref) and type_ref["kind"] == "primitive" and type_ref["name"] in names


def _is_text(type_ref) -> bool:
    return _is_primitive(type_ref, "string", "any")


def _is_number(type_ref) -> bool:
    return _is_primitive(type_ref, "integer", "float", "decimal")


def _is_date(type_ref) -> bool:
    return _is_primitive(type_ref, "datetime", "date")


def available_transforms(source_type: dict | None, target_type: dict) -> list[str]:
    """Transformations that make sense for these types: the rest are not offered."""
    kinds = ["direct"]
    if _is_text(target_type):
        kinds.append("concat")
    if _is_text(source_type) and _is_text(target_type):
        kinds.append("split")
    source_enum = bool(source_type) and source_type["kind"] == "enum"
    if _is_primitive(target_type, "boolean") and (_is_text(source_type) or source_enum):
        kinds.append("boolean")
    if target_type["kind"] == "enum" and (_is_text(source_type) or source_enum):
        kinds.append("enum")
    if (_is_number(source_type) and _is_date(target_type)) or (_is_date(source_type) and _is_number(target_type)):
        kinds.append("epoch")
    if _is_number(source_type) and _is_number(target_type):
        kinds.append("arithmetic")
    kinds.extend(["constant", "expression"])
    return kinds


def _default_constant(type_ref: dict, target: dict):
    if type_ref["kind"] == "enum":
        enum_def = find_enum(target, type_ref["name"])
        return enum_def["values"][0]["name"] if enum_def and enum_def["values"] else ""
    if _is_number(type_ref):
        return 0
    if _is_primitive(type_ref, "boolean"):
        return False
    return ""


def parse_value(text: str, type_ref: dict):
    """A value typed by the user, read as the target field's type. Empty text means "no value" (UNSET)."""
    if text == "":
        return UNSET
    if _is_number(type_ref):
        try:
            value = float(text)
        except ValueError:
            return UNSET
        if not math.isfinite(value):
            return UNSET
        return int(value) if value.is_integer() else value
    if _is_primitive(type_ref, "boolean"):
        return text == "true"
    return text


def _shown(value) -> str:
    return "" if value is None else js_string(value) if not isinstance(value, str) else value


class FieldEditor(QFrame):
    """The relation being edited. update_set is emitted with the new mapping set."""

    update_set = Signal(object)
    closed = Signal()

    def __init__(self, i18n):
        super().__init__()
        self.setObjectName("editorBox")
        self._i18n = i18n
        self._layout = QVBoxLayout(self)
        self._layout.setContentsMargins(14, 12, 14, 12)
        self._layout.setSpacing(8)

    def show_field(
        self, mapping_set: dict, mapping: dict, field: dict, source: dict, target: dict, diagnostics
    ) -> None:
        clear_layout(self._layout)
        t = self._i18n.t
        target_model = find_model(target, mapping["target"])
        target_field = next(
            (item for item in all_fields(target, target_model) if item["name"] == field["target"]), None
        )
        if not target_field:
            return
        source_model = find_model(source, mapping["source"])
        options = source_options(source, source_model) if source_model else []
        first = resolve_path(source, mapping["source"], field["sources"][0]) if field["sources"] else None
        source_type = first["type"] if first else None
        transform = field["transform"]
        target_type = target_field["type"]
        target_enum = find_enum(target, target_type["name"]) if target_type["kind"] == "enum" else None
        source_enum = find_enum(source, source_type["name"]) if source_type and source_type["kind"] == "enum" else None
        identifier, name = mapping["id"], field["target"]

        def update(next_set: dict) -> None:
            self.update_set.emit(next_set)

        header = QHBoxLayout()
        title = QLabel(t.edit_field_title(name))
        title.setProperty("role", "sectionTitle")
        header.addWidget(title)
        header.addWidget(muted(describe_type(target_type), False))
        header.addStretch()
        close = small_button(t.close)
        close.clicked.connect(self.closed.emit)
        header.addWidget(close)
        self._layout.addLayout(header)

        # Suggestions
        candidates = [
            candidate
            for candidate in field.get("candidates") or []
            if candidate["sources"] or candidate["transform"]["kind"] == "constant"
        ]
        if candidates and (field["status"] != "active" or len(candidates) > 1):
            label = QLabel(t.candidates_title)
            label.setProperty("role", "fieldLabel")
            self._layout.addWidget(label)
            for candidate in candidates:
                row = QHBoxLayout()
                paths = " + ".join(f"({t.root})" if not path else path_key(path) for path in candidate["sources"])
                row.addWidget(mono(paths))
                if candidate["transform"]["kind"] != "direct":
                    row.addWidget(muted(t.transform[candidate["transform"]["kind"]], False))
                row.addWidget(confidence_badge(t, candidate["confidence"], candidate["score"]))
                reasons = muted(" ".join(t.reason(reason) for reason in candidate["reasons"]))
                row.addWidget(reasons, 1)
                use = small_button(t.use_candidate)
                index = (field.get("candidates") or []).index(candidate)
                use.clicked.connect(
                    lambda _=False, index=index: update(accept_candidate(mapping_set, identifier, name, index))
                )
                row.addWidget(use)
                self._layout.addLayout(row)

        grid = QGridLayout()
        grid.setHorizontalSpacing(10)
        grid.setVerticalSpacing(6)
        row_index = 0

        def add_row(text: str, widget: QWidget) -> None:
            nonlocal row_index
            label = QLabel(text)
            label.setProperty("role", "fieldLabel")
            grid.addWidget(label, row_index, 0)
            grid.addWidget(widget, row_index, 1)
            row_index += 1

        # Transformation
        kinds = available_transforms(source_type, target_type)
        shown_kind = "direct" if transform["kind"] in ("object", "collection") else transform["kind"]
        items = []
        for kind in kinds:
            if kind == "direct" and transform["kind"] in ("object", "collection"):
                items.append((t.transform[transform["kind"]], kind))
            else:
                items.append((t.transform[kind], kind))
        kind_box = combo(items, shown_kind)
        kind_box.activated.connect(
            lambda _index: self._change_kind(
                kind_box.currentData(),
                mapping_set,
                mapping,
                field,
                target_field,
                source,
                target,
                source_enum,
                target_enum,
            )
        )
        add_row(t.transform_label, kind_box)

        # Source fields
        if transform["kind"] not in ("constant", "expression"):
            target_is_model = target_type["kind"] == "model"
            sources_widget = QWidget()
            sources_layout = QVBoxLayout(sources_widget)
            sources_layout.setContentsMargins(0, 0, 0, 0)
            sources_layout.setSpacing(4)
            paths = field["sources"] if field["sources"] else [None]
            concat = transform["kind"] == "concat"
            rows = [*paths, None] if concat else paths

            def set_source_at(position: int, path) -> None:
                sources = list(field["sources"])
                if path is None:
                    if position < len(sources):
                        del sources[position]
                elif position < len(sources):
                    sources[position] = path
                else:
                    sources.append(path)
                next_set = choose_sources(mapping_set, source, target, identifier, name, sources)
                # Keeping a concatenation while its fields change
                if concat and len(sources) > 1:
                    next_set = set_transform(next_set, identifier, name, transform)
                update(next_set)

            for position, path in enumerate(rows):
                line = QHBoxLayout()
                choices = [(t.choose_source, "")]
                if target_is_model:
                    choices.append((f"({t.root})", "."))
                choices += [
                    (f"{path_key(option['path'])} · {describe_type(option['field']['type'])}", path_key(option["path"]))
                    for option in options
                ]
                current = None if path is None else ("." if not path else path_key(path))
                box = combo(choices, current if current is not None else "")

                def chosen(_index, box=box, position=position) -> None:
                    value = box.currentData()
                    if value:
                        set_source_at(position, [] if value == "." else value.split("."))

                box.activated.connect(chosen)
                line.addWidget(box, 1)
                if concat and len(field["sources"]) > 1 and path:
                    remove = small_button("×")
                    remove.clicked.connect(lambda _=False, position=position: set_source_at(position, None))
                    line.addWidget(remove)
                holder = QWidget()
                holder.setLayout(line)
                line.setContentsMargins(0, 0, 0, 0)
                sources_layout.addWidget(holder)
            add_row(t.sources_label, sources_widget)

        def text_input(value: str, commit, placeholder: str = "") -> QLineEdit:
            widget = QLineEdit(value)
            widget.setPlaceholderText(placeholder)
            widget.editingFinished.connect(lambda: commit(widget.text()) if widget.isModified() else None)
            return widget

        kind = transform["kind"]
        if kind == "concat":
            add_row(
                t.separator_label,
                text_input(
                    transform["separator"],
                    lambda text: update(set_transform(mapping_set, identifier, name, {**transform, "separator": text})),
                ),
            )
        if kind == "split":
            add_row(
                t.separator_label,
                text_input(
                    transform["separator"],
                    lambda text: update(
                        set_transform(mapping_set, identifier, name, {**transform, "separator": text or " "})
                    ),
                ),
            )
            part_box = combo(
                [(t.parts["first"], 0), (t.parts["rest"], "rest"), (t.parts["last"], "last")], transform["part"]
            )
            part_box.activated.connect(
                lambda _i: update(
                    set_transform(mapping_set, identifier, name, {**transform, "part": part_box.currentData()})
                )
            )
            add_row(t.part_label, part_box)
        if kind == "constant":
            if target_enum:
                box = combo([(value["name"], value["name"]) for value in target_enum["values"]], transform["value"])
                box.activated.connect(
                    lambda _i: update(
                        set_transform(mapping_set, identifier, name, {"kind": "constant", "value": box.currentData()})
                    )
                )
                add_row(t.constant_label, box)
            elif _is_primitive(target_type, "boolean"):
                box = combo([("true", True), ("false", False)], transform["value"])
                box.activated.connect(
                    lambda _i: update(
                        set_transform(mapping_set, identifier, name, {"kind": "constant", "value": box.currentData()})
                    )
                )
                add_row(t.constant_label, box)
            else:

                def commit_constant(text: str) -> None:
                    value = parse_value(text, target_type)
                    constant = None if value is UNSET else value
                    update(set_transform(mapping_set, identifier, name, {"kind": "constant", "value": constant}))

                add_row(t.constant_label, text_input(_shown(transform["value"]), commit_constant, t.constant_null))
        if kind == "boolean":

            def commit_true_values(text: str) -> None:
                values = [value.strip() for value in text.split(",") if value.strip()]
                update(set_transform(mapping_set, identifier, name, {"kind": "boolean", "trueValues": values}))

            values_input = text_input(", ".join(transform["trueValues"]), commit_true_values)
            if source_enum:
                values_input.setToolTip(", ".join(value["name"] for value in source_enum["values"]))
            add_row(t.true_values_label, values_input)
        if kind == "epoch":
            unit_box = combo(
                [(t.epoch_units["seconds"], "seconds"), (t.epoch_units["milliseconds"], "milliseconds")],
                transform["unit"],
            )
            unit_box.activated.connect(
                lambda _i: update(
                    set_transform(mapping_set, identifier, name, {"kind": "epoch", "unit": unit_box.currentData()})
                )
            )
            add_row(t.epoch_unit_label, unit_box)
        if kind == "arithmetic":
            operator_box = combo([(operator, operator) for operator in ("*", "/", "+", "-")], transform["operator"])
            operator_box.activated.connect(
                lambda _i: update(
                    set_transform(mapping_set, identifier, name, {**transform, "operator": operator_box.currentData()})
                )
            )
            add_row(t.operator_label, operator_box)

            def commit_operand(text: str) -> None:
                value = parse_value(text, {"kind": "primitive", "name": "float"})
                if value is not UNSET:
                    update(set_transform(mapping_set, identifier, name, {**transform, "operand": value}))

            add_row(t.operand_label, text_input(_shown(transform["operand"]), commit_operand))
        self._layout.addLayout(grid)

        if kind == "enum":
            pairs_grid = QGridLayout()
            pairs_grid.addWidget(self._label(t.enum_from_label), 0, 0)
            pairs_grid.addWidget(self._label(t.enum_to_label), 0, 1)
            sources_values = (
                [value["name"] for value in source_enum["values"]]
                if source_enum
                else [pair["from"] for pair in transform["pairs"]]
            )
            for position, origin in enumerate(sources_values, start=1):
                pair = next((item for item in transform["pairs"] if item["from"] == origin), None)
                choices = [("—", "")] + [
                    (value["name"], value["name"]) for value in (target_enum or {"values": []})["values"]
                ]
                box = combo(choices, pair["to"] if pair else "")

                def pick(_index, box=box, origin=origin) -> None:
                    pairs = [item for item in transform["pairs"] if item["from"] != origin]
                    if box.currentData():
                        pairs.append({"from": origin, "to": box.currentData()})
                    update(set_transform(mapping_set, identifier, name, {**transform, "pairs": pairs}))

                box.activated.connect(pick)
                pairs_grid.addWidget(mono(origin), position, 0)
                pairs_grid.addWidget(box, position, 1)
            self._layout.addLayout(pairs_grid)
            fallback_choices = [(t.enum_fallback_error, "")] + [
                (value["name"], value["name"]) for value in (target_enum or {"values": []})["values"]
            ]
            fallback_box = combo(fallback_choices, transform.get("fallback", ""))

            def pick_fallback(_index) -> None:
                updated = {key: value for key, value in transform.items() if key != "fallback"}
                if fallback_box.currentData():
                    updated["fallback"] = fallback_box.currentData()
                update(set_transform(mapping_set, identifier, name, updated))

            fallback_box.activated.connect(pick_fallback)
            row = QHBoxLayout()
            row.addWidget(self._label(t.enum_fallback_label))
            row.addWidget(fallback_box, 1)
            self._layout.addLayout(row)

        if kind == "expression":
            row = QHBoxLayout()
            row.addWidget(self._label(t.expression_label))
            expression = text_input(
                transform["expression"], lambda text: update(set_expression(mapping_set, identifier, name, text))
            )
            expression.setProperty("role", "mono")
            row.addWidget(expression, 1)
            self._layout.addLayout(row)
            error = next(
                (
                    item.get("expressionError")
                    for item in diagnostics
                    if item["code"] == "invalidExpression"
                    and item.get("target") == name
                    and item["mapping"] == identifier
                ),
                None,
            )
            if error:
                message = QLabel(t.expression_error(error))
                message.setProperty("role", "error")
                message.setWordWrap(True)
                self._layout.addWidget(message)
            self._layout.addWidget(muted(t.expression_help))

        # Value used when the source is missing
        if kind != "constant":
            row = QHBoxLayout()
            row.addWidget(self._label(t.fallback_label))
            fallback = field.get("fallback")
            if target_enum or _is_primitive(target_type, "boolean"):
                values = [value["name"] for value in target_enum["values"]] if target_enum else ["true", "false"]
                current = "" if fallback is None else _shown(fallback)
                box = combo([(t.fallback_none, "")] + [(value, value) for value in values], current)

                def pick_value(_index, box=box) -> None:
                    value = box.currentData()
                    chosen = UNSET if value == "" else parse_value(value, target_type)
                    update(set_fallback(mapping_set, identifier, name, chosen))

                box.activated.connect(pick_value)
                row.addWidget(box, 1)
            else:
                row.addWidget(
                    text_input(
                        "" if fallback is None else _shown(fallback),
                        lambda text: update(
                            set_fallback(mapping_set, identifier, name, parse_value(text, target_type))
                        ),
                        t.fallback_hint,
                    ),
                    1,
                )
            self._layout.addLayout(row)

        # Actions
        actions = QHBoxLayout()
        if field["status"] == "pending":
            accept = small_button(t.accept, primary=True)
            accept.clicked.connect(lambda: update(accept_candidate(mapping_set, identifier, name)))
            actions.addWidget(accept)
        ignore = small_button(t.ignore_field)
        ignore.setEnabled(field["status"] != "ignored")
        ignore.clicked.connect(lambda: update(ignore_target(mapping_set, identifier, name)))
        reset = small_button(t.reset_field)
        reset.clicked.connect(lambda: update(reset_field(mapping_set, source, target, identifier, name)))
        actions.addWidget(ignore)
        actions.addWidget(reset)
        actions.addStretch()
        self._layout.addLayout(actions)

    def _label(self, text: str) -> QLabel:
        label = QLabel(text)
        label.setProperty("role", "fieldLabel")
        return label

    def _change_kind(
        self, kind, mapping_set, mapping, field, target_field, source, target, source_enum, target_enum
    ) -> None:
        identifier, name = mapping["id"], field["target"]
        if kind == "direct":
            next_set = choose_sources(mapping_set, source, target, identifier, name, field["sources"][:1])
        elif kind == "concat":
            next_set = set_transform(mapping_set, identifier, name, {"kind": "concat", "separator": " "})
        elif kind == "split":
            next_set = set_transform(mapping_set, identifier, name, {"kind": "split", "separator": " ", "part": 0})
        elif kind == "constant":
            value = _default_constant(target_field["type"], target)
            next_set = set_transform(mapping_set, identifier, name, {"kind": "constant", "value": value})
        elif kind == "boolean":
            next_set = set_transform(mapping_set, identifier, name, {"kind": "boolean", "trueValues": []})
        elif kind == "enum":
            pairs = (
                suggest_enum_pairs(source, source_enum["name"], target, target_enum["name"])
                if source_enum and target_enum
                else []
            )
            next_set = set_transform(mapping_set, identifier, name, {"kind": "enum", "pairs": pairs})
        elif kind == "epoch":
            next_set = set_transform(mapping_set, identifier, name, {"kind": "epoch", "unit": "seconds"})
        elif kind == "arithmetic":
            next_set = set_transform(
                mapping_set, identifier, name, {"kind": "arithmetic", "operator": "/", "operand": 100}
            )
        elif kind == "expression":
            next_set = set_expression(
                mapping_set, identifier, name, " + ".join(path_key(path) for path in field["sources"])
            )
        else:
            return
        self.update_set.emit(next_set)
