"""Where save dialogs start."""

from pathlib import Path

from PySide6.QtCore import QStandardPaths


def in_downloads(file_name: str) -> str:
    """The Downloads folder, like the browser in the web version. Without it, the dialog would start in
    the working folder, which for the packaged app is the root of the disk."""
    folder = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation)
    return str(Path(folder) / file_name) if folder else file_name
