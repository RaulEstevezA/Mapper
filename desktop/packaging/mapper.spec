# PyInstaller build of the desktop app. From desktop/:
#
#     pyinstaller packaging/mapper.spec
#
# Result in dist/: Mapper.app on macOS, an Mapper folder with Mapper.exe on Windows
# and with the Mapper binary on Linux.

import re
import sys
import tomllib
from pathlib import Path

HERE = Path(SPECPATH)
ROOT = HERE.parent
VERSION = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]

# Qt modules the app doesn't use. PyInstaller follows imports, but the PySide6 hooks pull in
# some of these through plugins; leaving them out keeps the download much smaller.
EXCLUDED = [
    "PySide6.QtWebEngineCore",
    "PySide6.QtWebEngineWidgets",
    "PySide6.QtWebEngineQuick",
    "PySide6.QtWebChannel",
    "PySide6.QtQml",
    "PySide6.QtQuick",
    "PySide6.QtQuickWidgets",
    "PySide6.QtMultimedia",
    "PySide6.QtPdf",
    "PySide6.Qt3DCore",
    "PySide6.QtCharts",
    "PySide6.QtDataVisualization",
    "PySide6.QtNetwork",
    "PySide6.QtOpenGL",
    "PySide6.QtSql",
    "PySide6.QtTest",
    "tkinter",
]

# Qt libraries and plugins that come in through other plugins (the virtual keyboard brings
# QML and Qt Quick, the PDF image plugin brings QtPdf). Matched against the bundled paths:
# QtQml.framework on macOS, Qt6Qml.dll on Windows, libQt6Qml.so.6 on Linux.
UNUSED_QT = re.compile(r"Qt6?(Qml|Quick|VirtualKeyboard|Pdf)|virtualkeyboard|qpdf", re.IGNORECASE)

analysis = Analysis(
    [str(HERE / "launcher.py")],
    pathex=[str(ROOT)],
    datas=[(str(ROOT / "mapper" / "assets"), "mapper/assets")],
    # The window icon is an SVG: Qt loads it through the QtSvg image plugin
    hiddenimports=["PySide6.QtSvg"],
    excludes=EXCLUDED,
)
analysis.binaries = [b for b in analysis.binaries if not UNUSED_QT.search(b[0])]
analysis.datas = [d for d in analysis.datas if not UNUSED_QT.search(d[0])]
pyz = PYZ(analysis.pure)

icon = str(HERE / ("icon.ico" if sys.platform == "win32" else "icon.icns"))
exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="Mapper",
    console=False,
    icon=icon,
)
collected = COLLECT(exe, analysis.binaries, analysis.datas, name="Mapper")

if sys.platform == "darwin":
    app = BUNDLE(
        collected,
        name="Mapper.app",
        icon=icon,
        bundle_identifier="io.github.raulesteveza.mapper",
        info_plist={
            "CFBundleShortVersionString": VERSION,
            "NSHighResolutionCapable": True,
            # Light and dark appearance follow the system
            "NSRequiresAquaSystemAppearance": False,
        },
    )
