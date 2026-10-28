"""What the window shows and works with: both inputs, the mapping with its undo history, the output settings
and the generated code. Mirrors the state of web/src/App.tsx.

Every change recomputes what depends on it and emits the signal of what changed, so the panels stay in sync.
Preferences are stored (QSettings); the inputs and the mapping only when the user turns on "Remember on this
computer", as in the web version.
"""

import json

from PySide6.QtCore import QObject, QSettings, QTimer, Signal

from ..core.generate.generators import find_generator
from ..core.generate.models import draft_target
from ..core.generate.plan import build_plan
from ..core.js import trim
from ..core.mapping.validate import validate_mapping
from ..core.model.schema import MODEL_SCHEMA_FORMAT
from ..core.parsers.registry import find_parser
from ..core.project.handoff import read_handoff, schema_text
from ..core.project.project import create_project, project_file_name, project_text, read_project
from ..core.workspace import EMPTY_INPUT, read_input, reconcile, summarize
from .examples import find_example

TOOL_NAMES = {"api2class": "Api2Class", "dbcreate": "DBCreate", "datacleanr": "DataCleanr", "mapper": "Mapper"}
# Steps kept for undo
HISTORY_LIMIT = 100


def _json_setting(value, default):
    try:
        result = json.loads(value) if isinstance(value, str) else default
    except ValueError:
        return default
    return result if isinstance(result, type(default)) else default


def _bool(value) -> bool:
    # QSettings gives back "true" / "false" strings with the INI format
    return value in (True, "true", "1", 1)


class Session(QObject):
    inputs_changed = Signal()
    mapping_changed = Signal()
    output_changed = Signal()
    message_changed = Signal()

    def __init__(self, settings: QSettings):
        super().__init__()
        self._settings = settings
        self.inputs = {"source": dict(EMPTY_INPUT), "target": dict(EMPTY_INPUT)}
        self.reads = {
            "source": read_input(self.inputs["source"], "source"),
            "target": read_input(self.inputs["target"], "target"),
        }
        self._models_key = ""
        self._past: list = []
        self._future: list = []
        self.mapping: dict | None = None
        self.diagnostics: list[dict] = []
        self.plan: dict | None = None
        self.output: dict | None = None
        # A message for the user: (text, "ok" | "error"), or None
        self.message: tuple[str, str] | None = None

        # Preferences (remembered)
        self.generator_id = str(settings.value("generator", "typescript"))
        self.modes: dict = _json_setting(settings.value("modes"), {})
        self.naming = str(settings.value("naming", "auto"))
        if self.naming not in ("auto", "keep", "convention"):
            self.naming = "auto"
        self.options: dict = _json_setting(settings.value("options"), {})
        self.remember = _bool(settings.value("remember", False))

        # The copy of the work kept while "remember" is on, written once changes pause
        self._save_timer = QTimer(self)
        self._save_timer.setSingleShot(True)
        self._save_timer.setInterval(600)
        self._save_timer.timeout.connect(self._save_workspace)

    # Inputs

    def schema(self, role: str) -> dict | None:
        outcome = self.reads[role]["outcome"]
        return outcome["schema"] if outcome and outcome["ok"] else None

    def model(self, role: str) -> str | None:
        return self.reads[role]["model"]

    def set_input(self, role: str, state: dict) -> None:
        if state == self.inputs[role]:
            return
        self.inputs[role] = state
        self.reads[role] = read_input(state, role)
        self.inputs_changed.emit()
        self._reconcile()

    def change_input(self, role: str, **changes) -> None:
        state = {**self.inputs[role], **changes}
        for key in [key for key, value in changes.items() if value is None and key in ("fileName", "receivedFrom")]:
            state.pop(key, None)
        self.set_input(role, state)

    def has_work(self) -> bool:
        return trim(self.inputs["source"]["text"]) != "" or trim(self.inputs["target"]["text"]) != ""

    def _reconcile(self) -> None:
        """New suggestions whenever the models change, keeping the user's decisions where they still apply."""
        source, target = self.schema("source"), self.schema("target")
        source_model, target_model = self.model("source"), self.model("target")
        if not source or not target or not source_model or not target_model:
            if self._models_key != "":
                self._models_key = ""
                self._reset(None)
            return
        key = json.dumps([source, source_model, target, target_model])
        if key == self._models_key:
            return
        self._models_key = key
        self._reset(reconcile(self.mapping, source, source_model, target, target_model))

    # Mapping and history

    @property
    def can_undo(self) -> bool:
        return bool(self._past)

    @property
    def can_redo(self) -> bool:
        return bool(self._future)

    def _reset(self, mapping: dict | None) -> None:
        self._past.clear()
        self._future.clear()
        self.mapping = mapping
        self._mapping_updated()

    def push(self, mapping: dict) -> None:
        """A change the user made: it can be undone."""
        if mapping == self.mapping:
            return
        self._past.append(self.mapping)
        del self._past[:-HISTORY_LIMIT]
        self._future.clear()
        self.mapping = mapping
        self._mapping_updated()

    def undo(self) -> None:
        if not self._past:
            return
        self._future.append(self.mapping)
        self.mapping = self._past.pop()
        self._mapping_updated()

    def redo(self) -> None:
        if not self._future:
            return
        self._past.append(self.mapping)
        self.mapping = self._future.pop()
        self._mapping_updated()

    def summary(self) -> dict:
        return summarize(self.mapping)

    def _mapping_updated(self) -> None:
        source, target = self.schema("source"), self.schema("target")
        ready = self.mapping is not None and source is not None and target is not None
        self.diagnostics = validate_mapping(self.mapping, source, target) if ready else []
        self.plan = build_plan(self.mapping, source, target) if ready else None
        self.mapping_changed.emit()
        self._generate()

    # Output

    @property
    def generator(self):
        return find_generator(self.generator_id)

    @property
    def settings(self) -> dict:
        generator = self.generator
        mode = self.modes.get(generator.id)
        return {
            "mode": mode if mode in generator.modes else generator.modes[0],
            "naming": self.naming,
            "options": dict(self.options.get(generator.id, {})),
        }

    def set_generator(self, generator_id: str) -> None:
        self.generator_id = find_generator(generator_id).id
        self._settings.setValue("generator", self.generator_id)
        self._generate()

    def set_settings(self, mode: str, naming: str, options: dict) -> None:
        self.modes = {**self.modes, self.generator_id: mode}
        self.naming = naming
        self.options = {**self.options, self.generator_id: options}
        self._settings.setValue("modes", json.dumps(self.modes))
        self._settings.setValue("naming", naming)
        self._settings.setValue("options", json.dumps(self.options))
        self._generate()

    def _generate(self) -> None:
        self.output = self.generator.generate(self.plan, self.settings) if self.plan else None
        self.output_changed.emit()
        if self.remember:
            self._save_timer.start()

    # Messages

    def set_message(self, text: str | None, kind: str = "ok") -> None:
        self.message = (text, kind) if text else None
        self.message_changed.emit()

    # Projects, examples and handoffs

    def current_project(self) -> dict | None:
        source, target = self.schema("source"), self.schema("target")
        reads = self.reads
        if not self.mapping or not source or not target:
            return None
        if (
            not reads["source"]["format"]
            or not reads["target"]["format"]
            or not self.model("source")
            or not self.model("target")
        ):
            return None
        settings = self.settings
        return create_project(
            {
                "format": reads["source"]["format"],
                "text": self.inputs["source"]["text"],
                "model": self.model("source"),
                "schema": source,
            },
            {
                "format": reads["target"]["format"],
                "text": self.inputs["target"]["text"],
                "model": self.model("target"),
                "schema": target,
            },
            self.mapping,
            {"generator": self.generator_id, "mode": settings["mode"], "naming": self.naming, "options": self.options},
        )

    def apply_project(self, project: dict) -> None:
        """Puts a project (a saved file, the copy kept on this computer) in the workspace."""
        for role in ("source", "target"):
            side = project[role]
            self.inputs[role] = {"text": side["text"], "format": side["format"], "model": side["model"]}
            self.reads[role] = read_input(self.inputs[role], role)
        # The mapping belongs to the models the project was saved with: it is kept as it is
        self._models_key = json.dumps(
            [
                project["source"]["schema"],
                project["source"]["model"],
                project["target"]["schema"],
                project["target"]["model"],
            ]
        )
        output = project["output"]
        self.generator_id = find_generator(output["generator"]).id
        self.modes = {**self.modes, output["generator"]: output["mode"]}
        self.naming = output["naming"]
        self.options = {**self.options, **output["options"]}
        self._settings.setValue("generator", self.generator_id)
        self._settings.setValue("modes", json.dumps(self.modes))
        self._settings.setValue("naming", self.naming)
        self._settings.setValue("options", json.dumps(self.options))
        self.inputs_changed.emit()
        self._reset(project["mapping"])
        # Texts that no longer read as the saved models get new suggestions, keeping the decisions that still apply
        self._reconcile()

    def read_project_file(self, text: str) -> dict:
        return read_project(text)

    def project_file(self) -> tuple[str, str] | None:
        """The current project as (text, suggested file name)."""
        project = self.current_project()
        return (project_text(project), project_file_name(project)) if project else None

    def target_model_file(self) -> tuple[str, str] | None:
        """The target's model schema, for DBCreate or another tool, as (text, suggested file name)."""
        target = self.schema("target")
        if not target:
            return None
        schema = {**target, "format": MODEL_SCHEMA_FORMAT, "root": self.model("target") or target.get("root")}
        return schema_text(schema), f"{self.model('target') or 'target'}.model.json"

    def load_example(self, example_id: str) -> None:
        example = find_example(example_id)
        if not example:
            return
        for role in ("source", "target"):
            side = example[role]
            self.inputs[role] = {"text": side["text"], "format": side["format"], "model": side["model"]}
            self.reads[role] = read_input(self.inputs[role], role)
        self.generator_id = example["language"]
        self._settings.setValue("generator", self.generator_id)
        self.set_message(None)
        self.inputs_changed.emit()
        self._reconcile()

    def create_target(self, format_id: str) -> str | None:
        """A new target model written from the source, to edit as text. Returns its name."""
        source, source_model = self.schema("source"), self.model("source")
        if not source or not source_model:
            return None
        draft = draft_target(source, source_model, format_id)
        if not draft:
            return None
        self.set_input("target", {"text": draft["text"], "format": format_id, "model": draft["model"]})
        return draft["model"]

    def receive(self, text: str) -> bool:
        """A model another tool of the family saved for Mapper (a model-handoff file). Returns whether it was one."""
        handoff = read_handoff(text)
        if not handoff:
            return False
        tool = TOOL_NAMES.get(handoff["from"], handoff["from"])
        if "text" in handoff:
            parser = find_parser(handoff["text"]["format"])
            state = {"text": handoff["text"]["content"], "format": parser.id if parser else None}
        else:
            state = {"text": schema_text(handoff["schema"]), "format": "modelschema"}
        self.set_input(handoff["role"], {**state, "model": handoff.get("model"), "receivedFrom": tool})
        return True

    # Work kept on this computer (opt-in)

    def set_remember(self, remember: bool) -> None:
        self.remember = remember
        self._settings.setValue("remember", remember)
        if remember:
            self._save_workspace()

    def has_saved(self) -> bool:
        return bool(self._settings.value("workspace"))

    def restore_saved(self) -> bool:
        """The work kept on this computer, when the user asked for it."""
        if not self.remember:
            return False
        raw = self._settings.value("workspace")
        read = read_project(raw) if isinstance(raw, str) else None
        if not read or not read["ok"]:
            return False
        self.apply_project(read["project"])
        return True

    def clear_saved(self) -> None:
        self._settings.remove("workspace")
        self.set_remember(False)

    def _save_workspace(self) -> None:
        if not self.remember:
            return
        project = self.current_project()
        if project:
            self._settings.setValue("workspace", json.dumps(project, ensure_ascii=False))
