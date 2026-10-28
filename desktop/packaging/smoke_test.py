"""Checks that the packaged app works: run by the release workflow as `Mapper --smoke-test`.

PyInstaller only bundles what it sees imported, so a module loaded in an unusual way can be missing from the
executable even though every test passes. This opens the window, loads every example, reads a YAML and an XML
document, generates the code of every language and saves a project, then exits with 0.
"""

import json
import sys
import tempfile
from pathlib import Path

from PySide6.QtCore import QTimer


def check(window) -> None:
    from mapper.core.generate.generators import GENERATORS
    from mapper.ui.examples import EXAMPLES

    session = window.session
    for example in EXAMPLES:
        session.load_example(example["id"])
        assert session.mapping is not None, example["id"]
    for generator in GENERATORS:
        session.set_generator(generator.id)
        assert window.code_panel.code.toPlainText().strip(), generator.id
    # PyYAML and the XML parser are imported by the parsers only when a document is read
    session.set_input("source", {"text": "id: 1\nname: Ana\n", "format": None, "model": None})
    assert session.reads["source"]["format"] == "yaml"
    session.set_input("source", {"text": "<user><id>1</id></user>", "format": None, "model": None})
    assert session.reads["source"]["format"] == "xml"
    session.load_example("arrays")
    with tempfile.TemporaryDirectory() as folder:
        target = Path(folder) / "order.mapper.json"
        window.project_bar.save_project(str(target))
        assert json.loads(target.read_text(encoding="utf-8"))["format"] == "mapper-project"


def main() -> None:
    from mapper.ui.app import create_app

    app, window = create_app([])
    window.show()

    def run() -> None:
        try:
            check(window)
        except Exception as error:
            print(f"Smoke test failed: {error!r}", file=sys.stderr)
            app.exit(1)
        else:
            print("Smoke test passed")
            app.exit(0)

    QTimer.singleShot(0, run)
    sys.exit(app.exec())
