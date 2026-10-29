# Changelog

Notable changes to Mapper, the web and the desktop version together. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). Desktop releases are tagged `v<version>` and published on [Releases](https://github.com/RaulEstevezA/Mapper/releases).

## [Unreleased]

### Added

- Web: privacy-first traffic and page-view measurement with Cloudflare Web Analytics.
- Web: **Open in Model2DB** sends the target model, with its text, to [Model2DB](https://github.com/RaulEstevezA/Model2DB) to design its database.

### Changed

- "Export target model" now names Model2DB, the tool that reads it, instead of the planned DBCreate.

## [0.1.1] - 2026-10-29

### Fixed

- **Numbers in custom expressions produced code that did not compile in typed languages.** An expression was translated as text, without looking at the types of its fields or of the target field. With the source field `total_cents: Long`, the target field `total: BigDecimal` and the expression `total_cents > 0 ? round(total_cents / 100) : 0`:

  | Language | Before | After |
  |---|---|---|
  | Kotlin | `if (totalCents > 0L) round(totalCents / 100L) else 0L` | `if (totalCents > 0L) (round(totalCents.toDouble() / 100.0)).toBigDecimal() else BigDecimal("0")` |
  | Java | `… ? Math.round(source.getTotalCents() / 100) : 0` | `… ? BigDecimal.valueOf(Math.round((double) source.getTotalCents() / 100.0)) : new BigDecimal("0")` |
  | C# | `… ? Math.Round(source.TotalCents / 100) : 0` | `… ? (decimal)(Math.Round((double)source.TotalCents / 100.0)) : 0m` |
  | Swift | `… ? round(totalCents / 100) : 0` | `… ? Decimal(round(Double(totalCents) / 100.0)) : 0` |
  | Go | `func() any { … return math.Round(source.TotalCents / 100) … }()` | `func() float64 { … return math.Round(float64(source.TotalCents) / 100.0) … }()` |
  | Rust | `source.total_cents / 100.round()` | `Decimal::try_from((source.total_cents as f64 / 100.0).round())…` |
  | Dart | `(totalCents / 100).round()` (an `int`) | `(totalCents.toDouble() / 100.0).roundToDouble()` |
  | Python | `round(source["total_cents"] / 100) … else 0` | `Decimal(str(round(source["total_cents"] / 100.0))) … else Decimal("0")` |

  Before, Kotlin called `round` with a `Long` (it only takes `Double` or `Float`) and assigned a `Long` to a `BigDecimal`. Java, C# and Swift divided two integers, losing the cents before rounding, and gave an integer where a decimal was expected. Rust rounded the literal `100` instead of the division. Go passed an `int64` to `math.Round` and returned `any` from the conditional. Dart gave an `int` for a `double` field. Python ran, but gave an `int` instead of a `Decimal`. TypeScript, JavaScript and PHP already worked; PHP now converts to `float` explicitly.

  **Solution.** The emitter shared by every generator (`web/src/core/generate/emitter.ts`, `desktop/mapper/core/generate/emitter.py`) now gives every part of an expression a number type and writes the conversions it needs:

  - `/` always divides as real numbers, as the expression language means it; integers stay integers through `+`, `-`, `*` and `%`.
  - Before an operator, a comparison, `min`/`max`, `??` or a conditional, both sides are brought to a common type: a number literal takes the other side's type, integers of different sizes meet as 64-bit integers, and anything else as a float.
  - A decimal field is read as a float where an operator works on it, and stays a decimal when it only passes through a conditional or `??`.
  - `round`, `floor` and `ceil` leave an integer unchanged; `length` and `substring` positions use each language's integer size.
  - The result is converted to the type of the target field, with the same conversions as a direct relation.

  Each language also had a few fixes of its own: Rust wraps an operation before `.round()`, `.min()` or `as`; Go types the function it writes for a conditional and writes the absolute value of an integer as `max(x, -x)` (`math.Abs` only takes a `float64`); Dart uses `roundToDouble()`, `floorToDouble()` and `ceilToDouble()`. JavaScript and TypeScript have a single number type and are written as before. The full rules are in [docs/transformations.md](docs/transformations.md#numbers).

  Tests: the shared case `shared/test-cases/generators/invoice-edited` was regenerated, and the new case `shared/test-cases/generators/expression-numbers` checks division, `length`, `abs` and `min` in every language, in both versions. The generated code was compiled and run with Java, Swift, Dart, PHP, Python and Rust; Kotlin, Go and C# were reviewed by hand.

  Known limitations: an expression that works with decimals computes in floating point (a direct relation or an arithmetic transformation keeps exact decimals), and `round` follows each language's own rounding of halves (C# and Python round half to even).

## [0.1.0] - 2026-10-29

First release of the desktop version, for Windows, macOS and Linux, with the same core as the web version.

### Fixed

- The automatic start-up check of the packaged app could crash on Linux when closing (`malloc_consolidate(): unaligned fastbin chunk detected`): the window is now deleted before the process ends.

[Unreleased]: https://github.com/RaulEstevezA/Mapper/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/RaulEstevezA/Mapper/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/RaulEstevezA/Mapper/releases/tag/v0.1.0
