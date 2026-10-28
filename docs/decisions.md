# Decisions

Choices that shape the project, with the reason, so they are not undone by accident.

| Decision | Reason |
|---|---|
| No backend | Models and code may be private; everything Mapper does fits in the browser (personal_web_style `UX_GUIDE.md`, local processing) |
| Hand-written parsers instead of compilers or language servers | They run in the browser, need no downloads per language, never execute code, and only have to find declarations |
| One `yaml` dependency for YAML | A correct YAML parser is large and subtle; this package is maintained and gives error positions |
| CodeMirror, languages loaded on demand | Same editor as Api2Class; only the languages in use are downloaded |
| Target-centric mapping (one entry per target field) | The generated code builds the target field by field, and "required field without value" is easy to see |
| Review and conflict suggestions are never applied | The engine helps; the user decides when the information is not enough (personal_web_style `patterns/confidence-states.md`) |
| A custom expression language instead of JavaScript | Expressions must work in eleven languages and must never be run in the browser |
| Inputs are not stored unless the user turns on "Remember in this browser" | personal_web_style stores preferences, not user data; the option makes the exception explicit and reversible ("Delete saved work") |
| Handoff through `sessionStorage`, `postMessage` or a file, never the URL | Models can be large and would stay in the browser history (`patterns/tool-continuity.md`) |
| Go mappers return `(T, error)` only when a conversion can fail | Idiomatic Go without forcing error handling on mappings that cannot fail |
| The deploy workflow is manual | Publishing the tool on the website is decided by the owner, not by the first push |
