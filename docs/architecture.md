# Architecture

Mapper turns two model descriptions into mapping code. Everything runs in the browser; there is no backend.

```text
Source text ──► Parser ──► ModelSchema ─┐
                                        ├──► Matching engine ──► MappingSet ──► Validation
Target text ──► Parser ──► ModelSchema ─┘          ▲                 │
                                                   │                 ▼
                                         user edits (edit.ts)   Plan (plan.ts) ──► Generator ──► code
```

Every stage has a language-neutral input and output, so adding a format or an output language never touches the stages around it.

| Stage | Input | Output | Code |
|---|---|---|---|
| Parsing | text in one of 23 formats | `ModelSchema` | `web/src/core/parsers/` |
| Matching | two `ModelSchema` + chosen models | `MappingSet` with confidence | `web/src/core/matching/` |
| Editing | `MappingSet` + a user action | a new `MappingSet` | `web/src/core/mapping/edit.ts` |
| Validation | `MappingSet` + both schemas | `Diagnostic[]` | `web/src/core/mapping/validate.ts` |
| Planning | `MappingSet` + both schemas | `Plan` (typed, null-aware values) | `web/src/core/generate/plan.ts` |
| Generation | `Plan` + settings | files | `web/src/core/generate/languages/` |

## Folders

```text
web/src/
├── core/                 No React: pure TypeScript, tested in Node
│   ├── model/            ModelSchema, type compatibility, naming
│   ├── parsers/          Formats: data/, schema/, code/ and the registry
│   ├── matching/         Name comparison and the suggestion engine
│   ├── mapping/          MappingSet types, paths, edits, validation
│   ├── transform/        The expression language
│   ├── generate/         Plan, emitter, naming rules and one file per language
│   └── project/          Project files and the handoff between tools
├── app/workspace.ts      Interface logic without React (reconcile, summary, filters)
├── components/           React components, one CSS file each
├── i18n/                 English and Spanish texts
├── examples/             Built-in examples, also used as test fixtures
└── styles/tokens/        Design tokens copied from personal_web_style
```

## Principles

- **The core has no interface code.** Everything under `core/` runs in Node and is covered by Vitest. The components only call it.
- **Values are immutable.** Edits return new `MappingSet`s; undo and redo keep previous values (`hooks/useHistory.ts`).
- **No decision is hidden.** The engine marks uncertain suggestions as `review` or `conflict` and never applies them; the user decides.
- **Nothing is executed.** Inputs are tokenized and read by hand-written parsers; custom expressions are parsed into a tree and translated, never evaluated (`docs/transformations.md`).
- **Local first.** Inputs stay in memory. Only preferences are stored, plus the workspace when the user turns on "Remember in this browser".

## Interface

The page follows the tool layout of personal_web_style (`layouts/tool-page.md`): presentation window, project bar, workspace, links, footer. The workspace has four parts: source and target inputs side by side, the relations, and the generated code. Below 1100px they become tabs (Source, Target, Relations, Code).

Inputs are parsed after the keystroke is painted (`useDeferredValue`). When the models change, `reconcile` (in `app/workspace.ts`) recomputes the suggestions and keeps every manual decision that still applies, so editing an input never throws the user's work away.

## Dependencies

| Package | Why |
|---|---|
| react, react-dom | Interface, as in Api2Class and DataCleanr |
| @codemirror/* | Code editors with highlighting; languages load on demand |
| yaml | YAML parsing with error positions (a correct YAML parser is not a small piece of code) |

Everything else (JSON with positions, CSV, XML through `DOMParser`, the code tokenizer, every parser and generator, the zip writer) is written in the repository. The decisions are listed in [decisions.md](decisions.md).
