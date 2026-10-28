# Mapper · Desktop

Desktop version of Mapper: Python + PySide6.

It does the same as the web version, on your computer and without a browser: it passes the same test cases from [`shared/test-cases/`](../shared/README.md) and suggests the same relations and generates exactly the same code for every language, mode and option.

What the tool does and its philosophy are in the [main README](../README_en.md).

## Download

| System | File |
|---|---|
| macOS (Apple Silicon) | [Mapper-macOS.dmg](https://github.com/RaulEstevezA/Mapper/releases/latest/download/Mapper-macOS.dmg) |
| Windows (x64) | [Mapper-Windows.zip](https://github.com/RaulEstevezA/Mapper/releases/latest/download/Mapper-Windows.zip) |
| Windows (ARM64) | [Mapper-Windows-ARM64.zip](https://github.com/RaulEstevezA/Mapper/releases/latest/download/Mapper-Windows-ARM64.zip) |
| Linux (x64) | [Mapper-Linux.tar.gz](https://github.com/RaulEstevezA/Mapper/releases/latest/download/Mapper-Linux.tar.gz) |
| Linux (ARM64, Ubuntu 24.04 or newer) | [Mapper-Linux-ARM64.tar.gz](https://github.com/RaulEstevezA/Mapper/releases/latest/download/Mapper-Linux-ARM64.tar.gz) |

Every version is in [Releases](https://github.com/RaulEstevezA/Mapper/releases).

> [!NOTE]
> The packaged app has been built and checked on **macOS** (Apple Silicon). The Windows and Linux builds are compiled by GitHub Actions and pass the tests and an automatic start-up check, but nobody has used them on a real computer yet. If you find a problem, write to [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

- **macOS:** open the `.dmg` and drag Mapper to Applications.
- **Windows:** unzip the `.zip` and run `Mapper.exe` inside the `Mapper` folder.
- **Linux:** extract with `tar -xzf Mapper-Linux.tar.gz` (or `Mapper-Linux-ARM64.tar.gz`) and run `Mapper/Mapper`. Some distributions need `libxcb-cursor0`. The ARM64 version needs a 2024 or newer distribution (glibc 2.39, like Ubuntu 24.04).

### Opening it the first time

The app is not signed (signing requires paid Apple and Microsoft accounts), so the system shows a warning the first time it is opened:

- **macOS** says it could not verify that the app is free of malware. Click **Done**, go to **System Settings → Privacy & Security**, scroll down to **Security** and click **Open Anyway**. This is only needed once.
- **Windows** shows "Windows protected your PC". Click **More info** and then **Run anyway**.

The code is the one in this repository, and the files are built by GitHub Actions ([workflow](../.github/workflows/release-desktop.yml)).

## Run locally

Requirements: Python 3.11 or newer.

```bash
cd desktop
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
python -m pytest                   # tests (shared cases from shared/test-cases/)
ruff check .                       # static analysis
python -m mapper                   # run the application
```

## Build the executable

```bash
pip install -e ".[build]"
pyinstaller packaging/mapper.spec
dist/Mapper.app/Contents/MacOS/Mapper --smoke-test   # macOS; dist/Mapper/Mapper elsewhere
```

The result is in `dist/`: `Mapper.app` on macOS and a `Mapper` folder with the executable on Windows and Linux. PyInstaller does not cross-compile: each system is built on its own operating system. `--smoke-test` opens the window, loads every example, reads a YAML and an XML document, generates every language and saves a project, to check that nothing was left out of the package.

## Structure

```
mapper/
  core/            Logic without UI: each module is the counterpart of one in web/src/core/
    parsers/       Every input format (data, schemas, code)
    matching/      The suggestions and their confidence
    mapping/       Edits and checks
    generate/      The plan and one module per output language
  ui/              Interface with PySide6
  assets/          Icon and check mark
packaging/         PyInstaller configuration, app icons and smoke test
tests/             Tests with pytest, reading the cases from shared/test-cases/
pyproject.toml     Dependencies and configuration
```

## Tests

The core is checked against [`shared/test-cases/`](../shared/README.md), the same files the web version's tests read: around 1,800 calls of the core (format detection, around 300 inputs in the 23 formats, suggestions, edits, checks, expressions, plans, target drafts, projects and handoffs) and the exact code of every generator, mode, naming mode and option for 8 pairs of models (336 outputs). Every one gives the same result as the web version. The interface tests open the window without showing it (`QT_QPA_PLATFORM=offscreen`): examples, edits and undo, every language, projects, the target draft, models received from Api2Class and the work kept on this computer.

## Differences with the web version

- **Models from other tools** arrive as files: the classes Api2Class generates open as they are, in any of its languages, and a model-handoff file ([docs/interoperability.md](../docs/interoperability.md)) opened in either input fills the side it was meant for. The web version's "Open in Mapper" button of Api2Class only reaches the web version.
- **"Remember on this computer"** keeps the work in the system's settings instead of the browser's storage.
- **No links**: the app works on its own, without going online. The credit opens the portfolio in the browser.

## Privacy

There are no network calls: files are read and the code is generated on the computer. Only preferences are saved (language, output language, modes, options, field names), in the system's settings; the inputs and the relations are saved only while "Remember on this computer" is on.

[Back to main README](../README_en.md)
