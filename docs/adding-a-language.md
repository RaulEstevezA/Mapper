# Adding a language

A language can be added as an **input** (a parser), as an **output** (a generator), or both. Neither touches the matching engine, the validation or the interface: they only work with the common model.

## Adding an input format

1. **Add the id** to `InputFormatId` in `web/src/core/parsers/types.ts`.
2. **Write the parser** in `web/src/core/parsers/code/<language>.ts` (or `schema/` for schema languages). Start from the closest existing one:
   - C-like with types after the name (`name: Type`): `kotlin.ts`, `swift.ts`.
   - C-like with types before the name (`Type name`): `java.ts`, `csharp.ts`.
   - Indentation-based: `python.ts`.
3. **Configure the lexer** (`LexerConfig`): comment markers, string delimiters, string prefixes, nested comments.
4. **Configure the type syntax** (`TypeSyntax`): generic brackets, `T?`, `T[]`, unions, pointers…
5. **Write the `TypeTable`**: the language's names for each common type, nullable boxed types, list and map types, optional wrappers (`Option<T>`), transparent wrappers (`Box<T>`).
6. **Read the declarations** into `RawModel`s and `RawEnum`s with the `Cursor`. Use `readAtAnnotation` or `readBracketAttributes` and `applyAnnotations` for annotations, and `parseLiteral` for default values. Set `construction` (named, positional, properties) and, when it matters to generators, `metadata` (how fields are read: getters, record accessors, public fields).
7. **Return** `buildSchema(declarations, TABLE, '<format>', '<language>')`, and report lexer errors with `failure(error.code, positionAt(text, error.index))`.
8. **Write `detect`**: telltale syntax only, fast, scoring 0 to 1. Make sure it does not steal similar languages (run the detection tests).
9. **Register it** in `parsers/registry.ts` with its file extensions (only extensions it really reads).
10. **Add highlighting** for its `editorLanguage` in `web/src/utils/editorLanguages.ts`.
11. **Test it** like the others (`parsers/test/*.test.ts`):
    - models, optional and nullable fields, collections, enums, framework annotations, comments as descriptions;
    - errors with position;
    - detection;
    - a sample in `SAMPLES` of `edgeCases.test.ts`, so truncated input is checked.

## Adding an output language

1. **Create** `web/src/core/generate/languages/<language>.ts` exporting a `CodeGenerator`.
2. **Define the naming rules** (`NamingRules`): convention, reserved words and how to escape them.
3. **Implement a `Syntax`** for the `Emitter`. Start from the closest generator:
   - Kotlin or Swift for languages with null-safe operators.
   - Java or Python for languages that need explicit null checks.
   - Go for languages without expressions for that.

   Put the type-specific conversions in `convert(expr, from, to)`. Keep helpers for enums as small functions, deduplicated by their pairs.
4. **Write the file:** imports (only the ones used), one function per `MapperPlan` (the root first), helpers. Respect the target model's `construction` and the source model's `metadata.accessors`.
5. **Handle the plan's marks:**
   - `missing` gets a placeholder marked TODO;
   - `unsafeNull` gets an assertion that fails loudly;
   - fields the language cannot omit get null or a default.
6. **Declare options** only when they change the code meaningfully (a module path, a package, an access style). Text options use `kind: 'text'`.
7. **Register it** in `generate/generators.ts`, and add mode and option labels to `i18n/messages.ts` (English and Spanish).
8. **Test it** with the five built-in examples (`generate/test/`):
   - file snapshots;
   - when the compiler or a syntax checker is available, a compile check through `runChecker`;
   - the "every generator" test checks a mapping with no relations.

## Before finishing

From `web/`:

```bash
npm run check   # types, lint, format and tests
npm run build
```

Then port the change to the desktop version: the same module under `desktop/mapper/core/` (registered in `parsers/registry.py` or `generate/generators.py`), a case in `shared/test-cases/` that uses it, `UPDATE_SHARED=1 npx vitest run src/core/shared.test.ts` from `web/`, and from `desktop/`:

```bash
ruff check . && ruff format --check . && pytest
```

Then add the language to the README tables (`README_en.md`, `README_es.md`) and to [parsers.md](parsers.md) or [generators.md](generators.md).
