import json
import os
from pathlib import Path

# Interface tests run without opening windows
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

SHARED_CASES = Path(__file__).resolve().parents[2] / "shared" / "test-cases"


def load_cases(name: str):
    """Loads a shared test case file, the same one the web version's tests read."""
    return json.loads((SHARED_CASES / name).read_text(encoding="utf-8"))


def as_json(value):
    """What JSON keeps of a value, as the files hold it (tuples become lists)."""
    return json.loads(json.dumps(value, ensure_ascii=False))


import pytest  # noqa: E402


@pytest.fixture
def window(tmp_path):
    """Main window with settings isolated in a temporary folder (no real preferences are touched)."""
    from PySide6.QtCore import QSettings

    QSettings.setDefaultFormat(QSettings.Format.IniFormat)
    QSettings.setPath(QSettings.Format.IniFormat, QSettings.Scope.UserScope, str(tmp_path))
    from mapper.ui.app import create_app

    app, main_window = create_app([])
    main_window.show()
    yield main_window
    main_window.close()
    app.processEvents()


@pytest.fixture(autouse=True)
def answer_yes(monkeypatch):
    """Confirmation dialogs would wait for a click: tests answer yes."""
    from PySide6.QtWidgets import QMessageBox

    monkeypatch.setattr(QMessageBox, "question", lambda *_args, **_kwargs: QMessageBox.StandardButton.Yes)
