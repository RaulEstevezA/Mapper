"""Creates the Qt application with the Mapper theme."""

import sys
from pathlib import Path

from PySide6.QtCore import QSettings
from PySide6.QtGui import QFontDatabase, QIcon
from PySide6.QtWidgets import QApplication

from .i18n import I18n
from .main_window import MainWindow
from .session import Session
from .theme import STYLESHEET


def create_app(argv: list[str] | None = None) -> tuple[QApplication, MainWindow]:
    app = QApplication.instance() or QApplication(argv if argv is not None else sys.argv)
    app.setApplicationName("Mapper")
    app.setOrganizationName("RaulEstevez")
    # The operating system's interface font, like the web version (system-ui)
    app.setFont(QFontDatabase.systemFont(QFontDatabase.SystemFont.GeneralFont))
    app.setStyleSheet(STYLESHEET)
    # Same icon as the web version (web/public/favicon.svg)
    app.setWindowIcon(QIcon(str(Path(__file__).resolve().parent.parent / "assets" / "icon.svg")))
    settings = QSettings()
    i18n = I18n(settings)
    session = Session(settings)
    window = MainWindow(i18n, session)
    # The work kept on this computer, when the user asked for it
    if session.restore_saved():
        session.set_message(i18n.t.restored)
    return app, window


def run() -> int:
    app, window = create_app()
    window.show()
    return app.exec()
