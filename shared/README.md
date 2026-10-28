# Shared

Language-neutral resources used by both the web (TypeScript) and desktop (Python) versions.

## test-cases/

Test cases that define the expected behavior of every part of the core. The Vitest suite (`web/src/core/shared.test.ts`) and the pytest suite (`desktop/tests/`) load the same files, so if one implementation behaves differently, its tests fail.

| Folder | What it checks |
|---|---|
| `calls/<module>.<function>.json` | Arguments of a core function and the result it gives, as JSON: names, compatibility, format detection and every parser, suggestions, edits, validation, expressions, plans, target drafts, projects and handoffs |
| `generators/<case>/` | `input.json` with two models (text, format and model) and optional edits; `prepared.json` with the models read and the mapping (the suggestion with every review accepted, then the edits); `expected.json` with the code of every generator for every mode, naming mode and option choice |

The arguments come from the calls the web test suite makes, so the cases cover what those tests cover. In the files, a missing key is `undefined` and `null` is `null`; trailing `undefined` arguments are left out.

### Updating the cases

When the web version changes on purpose, write the results again from what it does now:

```bash
cd web
UPDATE_SHARED=1 npx vitest run src/core/shared.test.ts
```

Then review the diff and port the change to `desktop/` until its tests pass. To add a case, add its arguments to a `calls/` file (the result is filled in by the update) or a folder with an `input.json` to `generators/`.

## How it maps to each version

Shared logic lives in a `core/` folder in each version, with no UI dependencies:

- Web: `web/src/core/` (TypeScript)
- Desktop: `desktop/mapper/core/` (Python)

A file in one `core/` has its counterpart in the other (e.g. `matching/engine.ts` / `matching/engine.py`), and both must pass the cases in `test-cases/`. In Python, models, mappings and transformations are dictionaries with the same keys as the JSON.

## Notes on the Python port

- Errors of YAML and XML documents come from different libraries in each version (`yaml` and `DOMParser` on the web, PyYAML and the standard library on the desktop): only the error code and position are compared, not the message.
- YAML is read with the YAML 1.2 core schema, like the web version: `yes` and `on` stay text and dates are not converted.
