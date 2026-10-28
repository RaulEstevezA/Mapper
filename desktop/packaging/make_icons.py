"""Generates icon.icns (macOS) and icon.ico (Windows) from mapper/assets/icon.svg.

The results are committed, so this only needs to run again if the icon changes:

    python packaging/make_icons.py
"""

import io
import sys
from pathlib import Path

from PIL import Image
from PySide6.QtCore import QBuffer, QRectF, Qt
from PySide6.QtGui import QGuiApplication, QImage, QPainter
from PySide6.QtSvg import QSvgRenderer

HERE = Path(__file__).resolve().parent
SVG = HERE.parent / "mapper" / "assets" / "icon.svg"
SIZE = 1024
# macOS icons leave a transparent margin around the shape (Apple's grid: 824 of 1024 px)
MAC_CONTENT = 824


def render(content: int) -> Image.Image:
    image = QImage(SIZE, SIZE, QImage.Format.Format_ARGB32)
    image.fill(Qt.GlobalColor.transparent)
    painter = QPainter(image)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    offset = (SIZE - content) / 2
    QSvgRenderer(str(SVG)).render(painter, QRectF(offset, offset, content, content))
    painter.end()
    buffer = QBuffer()
    buffer.open(QBuffer.OpenModeFlag.WriteOnly)
    image.save(buffer, "PNG")
    return Image.open(io.BytesIO(buffer.data().data()))


def main() -> None:
    QGuiApplication(sys.argv)
    render(MAC_CONTENT).save(HERE / "icon.icns")
    render(SIZE).save(HERE / "icon.ico", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])


if __name__ == "__main__":
    main()
