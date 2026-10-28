# Generators

A generator turns a **plan** into source files (`web/src/core/generate/`).

## From mapping to plan

`plan.ts` lowers the `MappingSet` so that generators only decide syntax. In the plan:

- every value says its type and whether it may be null;
- implicit conversions are explicit `convert` nodes (also between numbers of different size: some languages need a cast);
- parts of a concatenation that may be null are joined as empty text;
- fallbacks are `coalesce` nodes;
- nested objects call another mapper and lists map their elements;
- a target field that needs a value and gets none is marked `missing`; a value that may be null going into a required field is marked `unsafeNull`.

`planForPlainObjects` plans again for languages that read documents as plain objects (JavaScript, Python dictionaries, PHP arrays): dates, times and ids of a JSON document are text at run time, so they are converted.

## The emitter

`emitter.ts` walks the plan and asks a `Syntax` for each construct: field access (with a null-safe variant), literals, conversions, joins and splits, enum and boolean helpers, mapper calls, list mapping, fallbacks, null guards, placeholders and the expression language. The emitter decides where null guards go; the language only says how to write them (`x?.y`, `x.map { … }`, `mapPointer(x, …)`, `… if x is not None else None`).

## Languages

| Language | Modes | Shape of the code | Checked in tests |
|---|---|---|---|
| TypeScript | functions | `mapAToB(source): B`, object literals or `Object.assign(new B(), …)`, `import type` | type-checked with the TypeScript compiler |
| JavaScript | functions | the same with JSDoc | snapshots |
| Python | functions | `map_a_to_b(source: A) -> B`, keyword arguments; dictionaries for documents; Pydantic aliases | `python3 -m py_compile` |
| Java | manual, MapStruct | final class with static `toB(A)` (setters, record constructor or Lombok builder); MapStruct `@Mapper` interface with `@Mapping`, `@ValueMapping` | compiled with `javac` against test models |
| C# | manual, AutoMapper | extension methods `ToB(this A)`, object initializers or positional records; AutoMapper `Profile` | snapshots |
| Kotlin | extensions | `fun A.toB(): B = B(…)` with named arguments | snapshots |
| Dart | extensions | `extension AMapping on A { B toB() => B(…); }` | `dart format` (syntax) |
| Swift | extensions | `extension A { func toB() -> B { B(…) } }` | `swiftc -parse` |
| Go | functions | `MapAToB(source A) (B, error)`, errors collected with `errors.Join`, small generic helpers | snapshots |
| Rust | From | `impl From<&A> for B`, clones for non-Copy values, `Option` combinators | `rustfmt` (syntax) |
| PHP | static methods | final class with `public static function toB(A $source): B`, named arguments, `match` | `php -l` |

Compiler checks run when the tool is installed; on other machines the snapshot tests still run.

## Library integrations

- **MapStruct:** `@Mapping` only where names differ, nested paths (`source = "customer.id"`), constants, `defaultValue`, `ignore`, `expression = "java(…)"` for transformations, `@ValueMapping` for enums with `ANY_REMAINING` (a value or `THROW_EXCEPTION`). Nested objects and lists are mapped by the other methods of the interface.
- **AutoMapper:** `CreateMap` per pair, `ForMember` only where conventions do not find the value, `NullSubstitute` for fallbacks, `ConvertUsing` for enums. Expressions are written without null-conditional operators, which expression trees do not allow.

## What the generated code does not hide

- A field without value gets a placeholder marked TODO (`TODO("…")` in Kotlin, `todo!()` in Rust, `throw` expressions where the language has them, zero values otherwise) and a note in the interface.
- A required field whose source may be missing fails loudly (`requireNotNull`, `Objects.requireNonNull`, `?? throw`, `expect`) instead of using a silent default.
- Conversions from text that may fail are listed in the validation.

## Names

`naming.ts` decides how field names are written: as in the input when it is the same language (or a document read as plain objects), in the language's convention otherwise (camelCase, snake_case, PascalCase with Go initialisms). The interface lets the user force either. Reserved words are escaped per language.

## Target drafts

`models.ts` writes model declarations, not mappers: "Create" in the Target panel uses it to start a new target from the source model. It collects the source's root model with every nested model and enum it uses, names them without role suffixes (`UserDto` → `User`, `OrderApi.CustomerApi` → `Customer`, a document's `Source` → `Target`), converts the field names to the convention of the chosen format and writes:

| Format | Declarations |
|---|---|
| TypeScript | `export interface`, `?` for optional, `| null` for nullable, `export enum` |
| Python | `@dataclass` classes (fields with a default last), `str` enums, only the imports used |
| Kotlin | `data class` with `? = null` for values that may be missing, `enum class` |
| Java | `record`s, boxed types for values that may be missing, `enum` |
| C# | classes with `required` properties and nullable types, `enum` |
| JSON Schema | draft 2020-12 with `$defs`, `required`, formats and `null` in the types |

The text is then read back like any other input. The tests check, for every built-in example and every format, that the draft parses without warnings and that every one of its fields finds its source by itself.
