"""Main window: the presentation card (language switcher and examples), the project bar, the three panels
(inputs, relations, code) and the credit. Unlike the web version, it has no links: the app works on its own,
without going online."""

from PySide6.QtCore import Qt
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QButtonGroup,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from .code_panel import CodePanel
from .examples import EXAMPLES
from .i18n import MESSAGES, I18n
from .input_pane import InputPane
from .mapping_panel import MappingPanel
from .project_bar import ProjectBar
from .session import Session
from .theme import ACCENT

PORTFOLIO_URL = "https://raulesteveza.github.io/"


class LanguageSwitcher(QWidget):
    def __init__(self, i18n: I18n):
        super().__init__()
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)
        group = QButtonGroup(self)
        self._buttons = {}
        for code in MESSAGES:
            button = QPushButton(code.upper())
            button.setProperty("lang", True)
            button.setCheckable(True)
            button.clicked.connect(lambda _=False, code=code: i18n.set_language(code))
            group.addButton(button)
            layout.addWidget(button)
            self._buttons[code] = button
        self._i18n = i18n
        i18n.changed.connect(self._sync)
        self._sync()

    def _sync(self) -> None:
        self._buttons[self._i18n.language].setChecked(True)


class MainWindow(QMainWindow):
    def __init__(self, i18n: I18n, session: Session):
        super().__init__()
        self._i18n = i18n
        self.session = session
        self.setWindowTitle("Mapper")
        self.resize(1440, 920)

        central = QWidget()
        page = QVBoxLayout(central)
        page.setContentsMargins(20, 12, 20, 10)
        page.setSpacing(10)

        intro = QFrame()
        intro.setObjectName("card")
        intro_layout = QHBoxLayout(intro)
        intro_layout.setContentsMargins(28, 16, 28, 16)
        text = QVBoxLayout()
        title_row = QHBoxLayout()
        title = QLabel("Mapper")
        title.setProperty("role", "title")
        self.privacy_tag = QLabel()
        self.privacy_tag.setProperty("role", "privacyTag")
        title_row.addWidget(title)
        title_row.addWidget(self.privacy_tag)
        title_row.addStretch()
        text.addLayout(title_row)
        self.tagline = QLabel()
        self.tagline.setProperty("role", "subtitle")
        self.tagline.setWordWrap(True)
        self.description = QLabel()
        self.description.setProperty("role", "muted")
        self.description.setWordWrap(True)
        text.addWidget(self.tagline)
        text.addWidget(self.description)
        intro_layout.addLayout(text, 3)

        side = QVBoxLayout()
        # The language switcher sits in the card's top right corner: there is no header line
        side.addWidget(LanguageSwitcher(i18n), 0, Qt.AlignmentFlag.AlignRight)
        self.privacy_points = QLabel()
        self.privacy_points.setProperty("role", "muted")
        self.privacy_points.setWordWrap(True)
        side.addWidget(self.privacy_points)
        self.examples_label = QLabel()
        self.examples_label.setProperty("role", "fieldLabel")
        side.addWidget(self.examples_label)
        examples = QHBoxLayout()
        self._example_buttons = {}
        for example in EXAMPLES:
            button = QPushButton()
            button.setProperty("small", True)
            button.clicked.connect(lambda _=False, example_id=example["id"]: self.load_example(example_id))
            examples.addWidget(button)
            self._example_buttons[example["id"]] = button
        examples.addStretch()
        side.addLayout(examples)
        intro_layout.addLayout(side, 2)
        page.addWidget(intro)

        self.project_bar = ProjectBar(i18n, session)
        page.addWidget(self.project_bar)

        self.source_pane = InputPane("source", i18n, session)
        self.target_pane = InputPane("target", i18n, session)
        self.mapping_panel = MappingPanel(i18n, session)
        self.code_panel = CodePanel(i18n, session)
        inputs = QSplitter(Qt.Orientation.Vertical)
        inputs.addWidget(self.source_pane)
        inputs.addWidget(self.target_pane)
        inputs.setChildrenCollapsible(False)
        splitter = QSplitter(Qt.Orientation.Horizontal)
        for panel in (inputs, self.mapping_panel, self.code_panel):
            splitter.addWidget(panel)
        splitter.setChildrenCollapsible(False)
        splitter.setSizes([380, 640, 420])
        page.addWidget(splitter, 1)

        # Credit at the bottom; the name opens the portfolio in the browser
        self.credit = QLabel()
        self.credit.setProperty("role", "muted")
        self.credit.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.credit.setOpenExternalLinks(True)
        self.credit.setTextFormat(Qt.TextFormat.RichText)
        page.addWidget(self.credit)
        self.setCentralWidget(central)

        # Undo and redo the relations with the keyboard; text fields keep their own undo
        QShortcut(QKeySequence.StandardKey.Undo, self, session.undo)
        QShortcut(QKeySequence.StandardKey.Redo, self, session.redo)

        i18n.changed.connect(self._retranslate)
        self._retranslate()

    def load_example(self, example_id: str) -> None:
        if self.session.has_work():
            answer = QMessageBox.question(self, "Mapper", self._i18n.t.confirm_replace)
            if answer != QMessageBox.StandardButton.Yes:
                return
        self.session.load_example(example_id)

    def _retranslate(self) -> None:
        t = self._i18n.t
        self.privacy_tag.setText(t.privacy_short)
        self.tagline.setText(t.tagline)
        self.description.setText(t.intro_description)
        self.privacy_points.setText("\n".join(f"· {point}" for point in t.privacy_points))
        self.examples_label.setText(t.examples_label)
        for example_id, button in self._example_buttons.items():
            button.setText(t.examples[example_id])
            button.setToolTip(t.example_descriptions[example_id])
        link = f'<a href="{PORTFOLIO_URL}" style="color: {ACCENT}; text-decoration: none;">Raúl Estévez</a>'
        self.credit.setText(f"{t.developed_by} {link}")
