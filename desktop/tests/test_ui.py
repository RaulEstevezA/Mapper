"""The window, without opening it (QT_QPA_PLATFORM=offscreen): examples, edits, undo, code, projects, the target
draft, models received from other tools and the work kept on this computer."""

import json
import zipfile

from mapper.core.generate.generators import GENERATORS
from mapper.core.mapping.edit import ignore_target
from mapper.ui.examples import EXAMPLES


def test_every_example_gives_relations_and_code(window):
    for example in EXAMPLES:
        window.session.load_example(example["id"])
        assert window.session.mapping is not None, example["id"]
        assert window.session.output["files"][0]["code"].strip(), example["id"]
        assert window.code_panel.code.toPlainText() == window.session.output["files"][0]["code"]


def test_every_language_writes_code(window):
    window.session.load_example("transformations")
    for generator in GENERATORS:
        window.session.set_generator(generator.id)
        assert window.code_panel.code.toPlainText().strip(), generator.id


def test_typing_in_an_input_reads_it_after_a_pause(window):
    pane = window.source_pane
    pane.editor.setPlainText('{"id": 1, "name": "Ana"}')
    pane._commit_text()
    assert window.session.reads["source"]["format"] == "json"
    assert "2 campos" in pane.status.text() or "2 fields" in pane.status.text()


def test_a_syntax_error_is_shown_with_its_position(window):
    window.source_pane.set_text('{"id": 1,}')
    assert window.session.reads["source"]["outcome"]["ok"] is False
    assert "1" in window.source_pane.status.text()


def test_an_edit_can_be_undone_and_redone(window):
    session = window.session
    session.load_example("simple")
    root = session.mapping["root"]
    first = session.mapping["mappings"][0]["fields"][0]["target"]
    before = session.mapping
    session.push(ignore_target(session.mapping, root, first))
    assert session.mapping["mappings"][0]["fields"][0]["status"] == "ignored"
    session.undo()
    assert session.mapping == before
    session.redo()
    assert session.mapping["mappings"][0]["fields"][0]["status"] == "ignored"


def test_the_field_editor_applies_changes(window):
    session = window.session
    session.load_example("transformations")
    mapping = session.mapping["mappings"][0]
    field = mapping["fields"][0]
    window.mapping_panel.open_field(mapping["id"], field["target"])
    assert window.mapping_panel._editor_scroll.isVisible()
    window.mapping_panel.editor._change_kind(
        "constant",
        session.mapping,
        mapping,
        field,
        {"name": field["target"], "type": {"kind": "primitive", "name": "string"}},
        session.schema("source"),
        session.schema("target"),
        None,
        None,
    )
    changed = next(item for item in session.mapping["mappings"][0]["fields"] if item["target"] == field["target"])
    assert changed["transform"]["kind"] == "constant"


def test_accepting_every_suggestion(window):
    session = window.session
    session.load_example("transformations")
    assert session.summary()["review"] > 0
    window.mapping_panel._accept_all()
    assert session.summary()["review"] == 0


def test_a_project_is_saved_and_opened_again(window, tmp_path):
    session = window.session
    session.load_example("nested")
    session.push(
        ignore_target(session.mapping, session.mapping["root"], session.mapping["mappings"][0]["fields"][0]["target"])
    )
    path = tmp_path / "order.mapper.json"
    window.project_bar.save_project(str(path))
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["format"] == "mapper-project"
    mapping = session.mapping
    session.set_input("source", {"text": "", "format": None, "model": None})
    assert session.mapping is None
    window.project_bar.open_project(str(path))
    assert session.mapping == mapping
    assert session.inputs["source"]["text"] == saved["source"]["text"]


def test_a_damaged_project_is_rejected(window, tmp_path):
    path = tmp_path / "broken.json"
    path.write_text('{"format": "mapper-project", "version": 1}', encoding="utf-8")
    window.project_bar.open_project(str(path))
    assert window.session.message[1] == "error"


def test_the_target_model_is_exported(window, tmp_path):
    window.session.load_example("simple")
    path = tmp_path / "User.model.json"
    window.project_bar.export_target(str(path))
    schema = json.loads(path.read_text(encoding="utf-8"))
    assert schema["format"] == "model-schema"
    assert schema["root"] == window.session.model("target")


def test_a_target_is_created_from_the_source(window):
    session = window.session
    window.source_pane.set_text('{"user_id": 1, "full_name": "Ana", "tags": ["a"]}')
    model = session.create_target("kotlin")
    assert model == "Target"
    assert "data class Target" in session.inputs["target"]["text"]
    assert session.mapping is not None
    assert session.summary()["mapped"] == 3


def test_a_model_sent_by_another_tool_is_received(window, tmp_path):
    handoff = {
        "format": "model-handoff",
        "version": 1,
        "from": "api2class",
        "role": "source",
        "schema": {
            "format": "model-schema",
            "version": 1,
            "models": [
                {
                    "name": "User",
                    "kind": "class",
                    "fields": [
                        {
                            "name": "id",
                            "type": {"kind": "primitive", "name": "integer"},
                            "nullable": False,
                            "optional": False,
                        }
                    ],
                }
            ],
            "enums": [],
        },
        "text": {
            "format": "python",
            "content": "from dataclasses import dataclass\n\n\n@dataclass\nclass User:\n    id: int\n",
        },
    }
    path = tmp_path / "user.handoff.json"
    path.write_text(json.dumps(handoff), encoding="utf-8")
    window.target_pane.open_file(str(path))
    assert window.session.inputs["source"]["receivedFrom"] == "Api2Class"
    assert window.session.reads["source"]["format"] == "python"
    assert "Api2Class" in window.source_pane.status.text()


def test_code_with_several_files_is_saved_as_a_zip(window, tmp_path):
    window.session.load_example("simple")
    window.session.set_generator("typescript")
    path = tmp_path / "mapper.ts"
    window.code_panel.save(str(path))
    assert path.read_text(encoding="utf-8") == window.session.output["files"][0]["code"]


def test_the_work_is_kept_only_when_asked(window):
    session = window.session
    session.load_example("arrays")
    assert not session.has_saved()
    window.project_bar.remember.setChecked(True)
    assert session.has_saved()
    session.set_input("source", {"text": "", "format": None, "model": None})
    assert session.restore_saved()
    assert session.mapping is not None
    session.clear_saved()
    assert not session.has_saved()
    assert not session.remember


def test_the_language_can_be_switched(window):
    from mapper.ui.i18n import EN, ES

    window._i18n.set_language("es")
    assert window.source_pane.title.text() == ES.source_title
    window._i18n.set_language("en")
    assert window.source_pane.title.text() == EN.source_title


def test_the_zip_holds_every_file(window, tmp_path):
    window.session.load_example("simple")
    output = {"files": [{"name": "a.ts", "code": "a"}, {"name": "b.ts", "code": "b"}], "notes": []}
    window.session.output = output
    path = tmp_path / "code.zip"
    window.code_panel.save(str(path))
    with zipfile.ZipFile(path) as archive:
        assert sorted(archive.namelist()) == ["a.ts", "b.ts"]
