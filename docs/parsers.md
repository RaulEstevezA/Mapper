# Parsers

Every input format has an `InputParser` (`web/src/core/parsers/types.ts`) registered in `parsers/registry.ts`:

```ts
interface InputParser {
  id: InputFormatId
  kind: 'data' | 'schema' | 'code'
  label: string
  extensions: readonly string[]
  editorLanguage: string
  detect(text: string): number            // 0 to 1, cheap
  parse(text: string, options?): ParseOutcome
}
```

`parse` returns a `ModelSchema` with warnings, or an error with a code, a position and parameters. Codes are translated by the interface; parsers never produce user-facing text.

## Supported inputs

| Format | Kind | Reads | Notes |
|---|---|---|---|
| JSON | data | an example document | Arrays of objects are merged: missing keys are optional, `null` values nullable; ISO dates, times and UUIDs are recognized |
| YAML | data | an example document | Through the `yaml` package |
| XML | data | an example document | Attributes and children become fields; repeated children and `<items><item/></items>` become lists |
| CSV / TSV | data | header and rows | Delimiter detected; numbers with leading zeros stay text; at most 2,000 rows are read |
| JSON Schema | schema | `properties`, `required`, `$defs`, `$ref`, `enum`, `allOf`, `oneOf` with `null`, formats | JSON or YAML text |
| OpenAPI 3 / Swagger 2 | schema | `components.schemas`, `definitions` | `nullable`, `x-nullable`, `allOf` inheritance |
| GraphQL SDL | schema | `type`, `input`, `interface`, `enum`, `scalar`, `extend` | Fields are nullable unless marked `!`; Query, Mutation and Subscription are skipped |
| Protocol Buffers | schema | `message` (nested too), `enum`, `oneof`, `map`, `repeated`, `optional` | proto3 presence rules; `google.protobuf` well-known types |
| Prisma | schema | `model`, `enum`, `@default`, `@map`, `@updatedAt`, relations | Generated defaults (`autoincrement()`, `now()`) are marked as generated |
| Model schema | schema | Mapper's own interchange format | Validated field by field |
| TypeScript | code | interfaces, `type` aliases, classes, enums, literal unions, inline object types, intersections | TypeORM and class-validator decorators |
| JavaScript | code | classes, constructor assignments, JSDoc `@type`, `@param`, `@typedef` | Types from JSDoc or initial values |
| Python | code | classes, `__init__`, dataclasses, Pydantic, TypedDict, Enum, `Literal` | Django models (with the implicit `id`) and SQLAlchemy (classic and `Mapped`) |
| Java | code | classes, records, enums, nested classes, inheritance | JPA, Lombok (`@Data`, `@Builder`), Jackson annotations; getters vs public fields |
| C# | code | classes, structs, records (positional too), enums, properties | Data annotations, `JsonPropertyName`, Entity Framework; `DbContext` is skipped |
| Kotlin | code | data classes, body properties, enum classes | `@SerialName`, `@Json`, use-site targets |
| Dart | code | classes and constructors, enums (enhanced too) | json_serializable `@JsonKey`, freezed factories with `@Default` |
| Swift | code | structs, classes, enums with raw values | Codable `CodingKeys` give the names on the wire |
| Go | code | structs, embedding, pointers, `type X string` + `const` enums, `iota` | `json`, `db` and `gorm` struct tags |
| Rust | code | structs, enums | serde `rename`, `rename_all`, `default`, `skip`, `alias` |
| PHP | code | typed and promoted properties, enums | Docblock `@var` types for arrays, Doctrine attributes, getters |

## How code parsers work

Code is never run or evaluated. Three shared pieces do most of the work:

1. **`code/lexer.ts`** splits the text into identifiers, numbers, strings and punctuation, skipping comments. It is configured per language (comment markers, string delimiters and prefixes, nested comments, PHP `#[`, Rust raw strings) and attaches the comment before each token as documentation. The `Cursor` helps skipping balanced groups and reading ahead.
2. **`code/typeSyntax.ts`** reads a type expression with options per language: `<>` or `[]` generics, `T[]`, `T?`, `?T`, unions, intersections, `*T`, `[T]`, `[K: V]`, `[]T`, `map[K]V`, references. The result is a `RawType` tree.
3. **`code/raw.ts`** turns `RawType`s into common types with the language's `TypeTable` (primitives, nullable boxed types, lists, maps, optional wrappers, transparent wrappers, null names) and builds the `ModelSchema`, resolving references to models, enums and aliases declared in the same input.

`code/annotations.ts` reads `@Annotations` and `[Attributes]` and applies the well-known ones in one place: names on the wire (`@JsonProperty`, `[JsonPropertyName]`, `@SerializedName`, `@Column(name)`), nullability (`@NotNull`, `nullable = false`), generated values (`@GeneratedValue`, `@CreatedDate`) and fields that are not data (`@Transient`, `[NotMapped]`).

A language parser is therefore only the part that knows where declarations are: about 200 to 450 lines each.

## Detection

`detectFormats` asks every parser for a score on the first 20,000 characters and adds a strong bonus for a known file extension. Below 0.3 nothing is chosen and the interface asks the user. Detection never blocks: the format can always be chosen by hand.

## Robustness

`parseInput` catches any exception and reports it as an input error, so a parser bug can never break the page. A test (`parsers/test/edgeCases.test.ts`) feeds every parser random text and every sample cut at every few characters, and checks that none throws.
