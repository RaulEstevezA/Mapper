"""Dark theme with the same palette as the web version (and the portfolio), as in Api2Class and DataCleanr."""

from pathlib import Path

# Check mark of the checkboxes, drawn in the page color on the accent background like the web ones
CHECK_ICON = (Path(__file__).resolve().parent.parent / "assets" / "check.svg").as_posix()

PAGE_BG = "#0d1117"
SURFACE = "#161b22"
SURFACE_RAISED = "#21262d"
BORDER = "#30363d"
TEXT = "#e6edf3"
BTN_TEXT = "#c9d1d9"
MUTED = "#8b949e"
ACCENT = "#58a6ff"
ACCENT_SOFT = "#1a2740"
ACCENT_TEXT = "#79c0ff"
SUCCESS = "#3fb950"
SUCCESS_SOFT = "#12261e"
WARNING = "#d29922"
WARNING_SOFT = "#2b2111"
DANGER = "#f85149"
DANGER_SOFT = "#2d1416"

# GitHub's dark syntax colors, as in the web editors
SYNTAX = {
    "keyword": "#ff7b72",
    "string": "#a5d6ff",
    "constant": "#79c0ff",
    "property": "#7ee787",
    "type": "#ffa657",
    "function": "#d2a8ff",
    "comment": "#8b949e",
}

STYLESHEET = f"""
QWidget {{
    background: {PAGE_BG};
    color: {TEXT};
    font-size: 14px;
}}
QLabel {{ background: transparent; }}
QLabel[role="muted"] {{ color: {MUTED}; }}
QLabel[role="title"] {{ font-size: 32px; font-weight: 700; }}
QLabel[role="subtitle"] {{ color: {MUTED}; font-size: 17px; }}
QLabel[role="paneTitle"] {{ font-size: 17px; font-weight: 600; }}
QLabel[role="fieldLabel"] {{ color: {MUTED}; font-size: 13px; }}
QLabel[role="success"] {{ color: {SUCCESS}; }}
QLabel[role="error"] {{ color: {DANGER}; }}
QLabel[role="warning"] {{ color: {WARNING}; }}
QLabel[role="privacyTag"] {{
    color: {SUCCESS};
    border: 1px solid {SUCCESS};
    border-radius: 10px;
    padding: 1px 10px;
    font-size: 12px;
}}
QLabel[role="badge"] {{
    color: {MUTED};
    border: 1px solid {BORDER};
    border-radius: 10px;
    padding: 0 8px;
    font-size: 12px;
}}
QLabel[role="badge"][tone="success"] {{ color: {SUCCESS}; border-color: {SUCCESS}; }}
QLabel[role="badge"][tone="accent"] {{ color: {ACCENT_TEXT}; border-color: {ACCENT}; }}
QLabel[role="badge"][tone="warning"] {{ color: {WARNING}; border-color: {WARNING}; }}
QLabel[role="badge"][tone="danger"] {{ color: {DANGER}; border-color: {DANGER}; }}
QLabel[role="mono"] {{ font-family: "SF Mono", "Menlo", "Consolas", "DejaVu Sans Mono", monospace; font-size: 13px; }}
QLabel[role="sectionTitle"] {{ font-size: 15px; font-weight: 600; }}
QLabel[role="infoBox"] {{
    color: {TEXT};
    background: {ACCENT_SOFT};
    border: 1px solid {ACCENT};
    border-radius: 8px;
    padding: 8px 12px;
}}
QFrame#row {{ background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 8px; }}
QFrame#row[category="review"], QFrame#row[category="conflict"] {{ border-color: {WARNING}; }}
QFrame#row[open="true"] {{ border-color: {ACCENT}; }}
QFrame#editorBox {{ background: {SURFACE_RAISED}; border: 1px solid {BORDER}; border-radius: 8px; }}
QWidget[section="editorBox"] {{ background: {SURFACE_RAISED}; }}
QPushButton[small="true"] {{ padding: 3px 10px; font-size: 12px; }}
QPushButton[toggle="true"]:checked {{ background: {ACCENT_SOFT}; color: {TEXT}; border-color: {ACCENT}; }}
QScrollArea {{ border: none; background: transparent; }}
QScrollArea > QWidget > QWidget {{ background: transparent; }}
QTextBrowser {{ background: transparent; border: none; }}
QLabel[role="warningBox"] {{
    color: {WARNING};
    background: {WARNING_SOFT};
    border: 1px solid {WARNING};
    border-radius: 8px;
    padding: 8px 12px;
}}
QFrame#card {{
    background: {SURFACE};
    border: 1px solid {BORDER};
    border-radius: 14px;
}}
QFrame#pane {{
    background: {SURFACE};
    border: 1px solid {BORDER};
    border-radius: 8px;
}}
QWidget[section="pane"] {{ background: {SURFACE}; }}
QFrame#editor {{
    background: {SURFACE_RAISED};
    border: 1px solid {BORDER};
    border-radius: 8px;
}}
QWidget[section="editor"] {{ background: {SURFACE_RAISED}; }}
QPlainTextEdit {{
    background: {PAGE_BG};
    border: none;
    border-top: 1px solid {BORDER};
    selection-background-color: #264f78;
}}
QPushButton {{
    background: {SURFACE_RAISED};
    color: {BTN_TEXT};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 8px 16px;
    font-weight: 500;
}}
QPushButton:hover {{ background: {BORDER}; border-color: {MUTED}; }}
QPushButton:disabled {{ color: {MUTED}; }}
QPushButton[primary="true"] {{ background: {ACCENT}; color: {PAGE_BG}; border-color: {ACCENT}; }}
QPushButton[primary="true"]:hover {{ background: {ACCENT_TEXT}; border-color: {ACCENT_TEXT}; }}
QPushButton[primary="true"]:disabled {{ background: {ACCENT_SOFT}; color: {MUTED}; border-color: {ACCENT_SOFT}; }}
QPushButton[lang="true"] {{ background: transparent; border: none; color: {MUTED}; padding: 2px 8px; }}
QPushButton[lang="true"]:checked {{
    background: {SURFACE_RAISED};
    color: {TEXT};
    font-weight: 700;
    border-radius: 4px;
}}
QPushButton[link="true"] {{ background: transparent; border: none; color: {ACCENT}; padding: 0; }}
QPushButton[link="true"]:hover {{ text-decoration: underline; }}
QComboBox, QLineEdit {{
    background: {PAGE_BG};
    border: 1px solid {BORDER};
    border-radius: 6px;
    padding: 6px 10px;
}}
QLineEdit:focus, QComboBox:focus {{ border-color: {ACCENT}; }}
QComboBox QAbstractItemView {{ background: {SURFACE_RAISED}; selection-background-color: {ACCENT_SOFT}; }}
QCheckBox {{ background: transparent; spacing: 8px; }}
QCheckBox::indicator, QTreeView::indicator {{
    width: 14px;
    height: 14px;
    border-radius: 4px;
    border: 1px solid {MUTED};
    background: {PAGE_BG};
}}
QCheckBox::indicator:checked, QTreeView::indicator:checked {{
    background: {ACCENT};
    border-color: {ACCENT};
    image: url({CHECK_ICON});
}}
QCheckBox::indicator:unchecked:hover, QTreeView::indicator:unchecked:hover {{ border-color: {TEXT}; }}
QTreeWidget {{
    background: {SURFACE};
    border: none;
    font-family: "SF Mono", "Menlo", "Consolas", "DejaVu Sans Mono", monospace;
    font-size: 13px;
}}
QTreeWidget::item {{ padding: 2px 0; }}
QTreeWidget::item:selected {{ background: {ACCENT_SOFT}; color: {TEXT}; }}
QHeaderView::section {{
    background: {SURFACE};
    color: {MUTED};
    border: none;
    border-bottom: 1px solid {BORDER};
    padding: 4px 6px;
    font-size: 12px;
}}
QTabBar::tab {{
    background: transparent;
    color: {MUTED};
    padding: 4px 10px;
    border: 1px solid transparent;
    border-bottom: none;
    font-size: 12px;
}}
QTabBar::tab:selected {{ background: {PAGE_BG}; color: {TEXT}; border-color: {BORDER}; border-radius: 0; }}
QSplitter::handle {{ background: transparent; width: 12px; }}
QScrollBar:vertical {{ background: transparent; width: 10px; }}
QScrollBar::handle:vertical {{ background: {BORDER}; border-radius: 5px; min-height: 24px; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; }}
QScrollBar::handle:horizontal {{ background: {BORDER}; border-radius: 5px; min-width: 24px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}
QToolTip {{ background: {SURFACE_RAISED}; color: {TEXT}; border: 1px solid {BORDER}; }}
"""
