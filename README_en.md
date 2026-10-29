# Mapper

Mapper relates two data models and generates the code that converts one into the other. Everything happens on your side, in the browser or in the desktop app: what you paste or open is never sent anywhere, and code is analyzed, never run.

```text
Paste the source and the target  →  Review the suggested relations  →  Adjust transformations  →  Copy the mapping code
```

## What it does

1. **Reads both models** in any supported format — or **creates the target** from the source: "Create" in the Target panel writes a model with the same fields in TypeScript, Python, Kotlin, Java, C# or JSON Schema, ready to edit as text. It detects the format and the framework (Pydantic, JPA, Entity Framework, TypeORM, Django, SQLAlchemy, serde, Codable, freezed…). Inputs with several models let you choose which one to map; nested models are followed.
2. **Suggests a source for every target field**, with a confidence: exact, high, likely, review, conflict or no match. It recognizes:
   - naming conventions (`userId`, `user_id`) and names on the wire (`@JsonProperty`);
   - abbreviations (`qty`), compound words (`surname`) and synonyms (`creationDate` → `created_at`);
   - the model's name (`userId` → `id`) and nested fields (`customer.id` → `customer_id`);
   - type compatibility, and combinations: first + last name → full name, cents → amount, status → active, timestamps → dates, enum values.
3. **Never decides an ambiguity.** Two sources that fit almost equally, or one source wanted by two fields, become a conflict to resolve. Suggestions to review are not applied until accepted.
4. **Lets you change everything:**
   - choose sources, also several or nested ones, without drag and drop;
   - pick a transformation (join, part of a text, constant, text to true/false, value list, timestamp ↔ date, arithmetic, nested object, list, or a custom expression);
   - set a default value for missing sources, leave fields without value, undo and redo.
5. **Checks the result:** errors (a required field without value, incompatible types), warnings (null into a required field, conversions that may fail, enum values without a pair) and notes (unused source fields).
6. **Generates the mapping code**, with nested mappers, list mapping, null handling, enum helpers and only the imports it needs.

## Inputs and outputs

| Inputs | |
|---|---|
| Code | TypeScript (also Zod schemas), JavaScript, Python, Java, C#, Kotlin, Dart, Swift, Go, Rust, PHP, Scala |
| Schemas | JSON Schema, OpenAPI / Swagger, GraphQL, Protocol Buffers, Smithy, Prisma, Mapper model schema |
| Example documents | JSON, YAML, XML, CSV |

| Output | Styles |
|---|---|
| TypeScript, JavaScript | Functions |
| Python | Functions (attributes or dictionaries; dataclasses, Pydantic and plain classes) |
| Java | Manual mapper (setters, records, Lombok builders) or MapStruct |
| C# | Extension methods or AutoMapper profile |
| Kotlin, Dart, Swift | Extension functions |
| Go | Functions returning the conversion errors |
| Rust | `From` implementations |
| PHP | Static methods (objects or arrays) |

## Work with other tools

- **From Api2Class:** the classes Api2Class generates, in any of its languages and styles, open in Mapper as the source as they are; only the target is left to provide.
- **To Model2DB:** "Export target model" downloads the target as a model schema, which Model2DB (also its desktop version) opens as a file.
- **Projects:** "Save project" downloads the inputs, the relations and the output settings; "Open project" continues later. "Remember in this browser" ("Remember on this computer" in the desktop app) keeps the work there only, until you delete it. A project saved in one version opens in the other.

The formats are documented in [docs/interoperability.md](docs/interoperability.md).

## Versions

| | Web | Desktop |
|---|---|---|
| Technology | React + TypeScript + Vite | Python + PySide6 |
| Runs in | The browser | Installable application (Windows, macOS, Linux) |
| Status | Published: [raulesteveza.github.io/tools/Mapper](https://raulesteveza.github.io/tools/Mapper/) | [Download](./desktop/README_en.md#download) (built and checked on macOS) |
| Documentation | This README and [docs/](./docs) | [desktop/README_en.md](./desktop/README_en.md) |

The desktop app does what the web version does, with the same look, the same examples and English or Spanish. It receives models from other tools as files, instead of from another browser tab.

## Shared behavior

The two versions are written separately (TypeScript and Python), but **they behave the same**: the [`shared/`](./shared/README.md) folder holds the test cases that define what each part of the core must do, from detecting and reading every input format to the suggestions, edits, checks, target drafts, projects and the exact code of every generator in every mode and option. The web and desktop tests read the same files, so a difference in either version makes its tests fail.

## Development

The web version is in [`web/`](./web): React, TypeScript and Vite, without component libraries; its look follows the shared design of the portfolio and the other tools.

```bash
cd web
npm install
npm run dev      # development server
npm run check    # types, lint, format and tests
npm run build    # production build in web/dist
```

The tests include parsers for every format, the matching engine, transformations, validation, generators (snapshots, and a compile or syntax check when `python3`, `javac`, `dart`, `swiftc`, `rustfmt` or `php` are installed), the shared cases and the main interface flows.

The desktop version is in [`desktop/`](./desktop): see [desktop/README_en.md](./desktop/README_en.md#run-locally) to run it, test it and build the executable.

## Repository structure

```
web/                     Web version (React + TypeScript + Vite)
  src/core/              Logic without interface: model, parsers, matching, mapping, expressions, generators, projects
  src/components/        React interface
desktop/                 Desktop version (Python + PySide6)
  mapper/core/           The same logic as web/src/core/, in Python
  mapper/ui/             Interface with PySide6
shared/                  Behavior common to both versions
  test-cases/            Calls of the core and the code expected from every generator
docs/                    Technical documentation and images
```

## Documentation

| Document | Content |
|---|---|
| [architecture.md](docs/architecture.md) | Stages, folders and principles |
| [internal-model.md](docs/internal-model.md) | The model schema and the mapping |
| [parsers.md](docs/parsers.md) | What each format reads and how code parsers work |
| [mapping-engine.md](docs/mapping-engine.md) | How suggestions and confidence are computed |
| [transformations.md](docs/transformations.md) | Transformations, conversions, the expression language and validation |
| [generators.md](docs/generators.md) | From mapping to code, per language |
| [interoperability.md](docs/interoperability.md) | Model schema, handoff between tools, project files |
| [adding-a-language.md](docs/adding-a-language.md) | Step by step for a new input or output language |
| [decisions.md](docs/decisions.md) | Design decisions and their reasons |

## Suggestions

Ideas for improvements, bugs or a format you would like Mapper to read: write to [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

## Developer

**Raul Estevez**

- [Personal Website](https://raulesteveza.github.io/)
- [LinkedIn Profile](https://www.linkedin.com/in/raulesteveza/)

## License

[MIT](./LICENSE)
