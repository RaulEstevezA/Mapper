# Transformations

A relation's `transform` says how its sources become the target value (`web/src/core/mapping/types.ts`).

| Transform | Sources | Parameters | Example |
|---|---|---|---|
| direct | 1 | — | `source.userId` → `id`, converted if the types differ |
| concat | 2 or more | separator | `firstName + " " + lastName` |
| split | 1 (text) | separator, part (first, last, after the first, index) | `fullName` → first name |
| constant | 0 | value | `"ACTIVE"` |
| boolean | 1 (text or enum) | values that mean true | `"ACTIVE"` → `true` |
| enum | 1 (text or enum) | pairs, value for the rest | `PENDING` → `WAITING` |
| epoch | 1 | seconds or milliseconds | `1767225600` → date |
| arithmetic | 1 (number) | operator and number | `price_cents / 100` |
| object | 1 object, or the whole source | nested mapping | `address` → `AddressDto` |
| collection | 1 list or dictionary | nested mapping for objects | `items[]` → `products[]` |
| expression | any | expression text | `upper(trim(name))` |

Any relation can also have a **fallback**: the value used when the source is null or missing (`null → default`).

## Implicit conversions

A direct relation between different types gets the conversion its types call for, written by each generator in its own language:

| From → to | Example in Java |
|---|---|
| number → text | `String.valueOf(x)` |
| text → number | `Long.parseLong(x)` (may fail: warned) |
| integer → decimal | `BigDecimal.valueOf(x)` |
| wider → narrower integer | `Math.toIntExact(x)` (lossy: warned) |
| ISO text → date and time | `OffsetDateTime.parse(x)` |
| date and time → text | `x.toString()` |
| enum → text | `x.name()` |
| text → enum | `Status.valueOf(x)` |

Conversions that only the user can define (which texts mean true, the unit of a timestamp, how two enums correspond) are never guessed silently: the relation is marked for review.

## Custom expressions

`web/src/core/transform/expression.ts` implements a small language for cases the predefined transformations do not cover:

```text
expression  := conditional
conditional := binary ( "?" expression ":" expression )?
binary      := unary ( operator unary )*        operators: ?? || && == != < <= > >= + - * / %
unary       := ( "-" | "!" ) unary | primary
primary     := number | "text" | true | false | null | field | call | "(" expression ")"
field       := name ( "." name )*               source.address.city or address.city
call        := function "(" arguments ")"
```

Functions: `upper`, `lower`, `trim`, `length`, `concat`, `substring`, `replace`, `round`, `floor`, `ceil`, `abs`, `min`, `max`, `toString`, `toNumber`.

### Numbers

The checker only knows "number", but typed languages have several, so the emitter (`web/src/core/generate/emitter.ts`) gives every part of an expression a number type and writes the conversions it needs, the same way for every language:

- Integers stay integers through `+`, `-`, `*` and `%`. `/` always divides as real numbers, so `cents / 100` is a float, never an integer division.
- Two numbers of different types meet in a common one before an operator, a comparison, `min`/`max`, `??` or the branches of a conditional: a number literal takes the other side's type when it fits (`cents > 0` stays `cents > 0L` in Kotlin), integers of different sizes meet as 64-bit integers, and anything else as a float.
- A decimal field (`BigDecimal`, `decimal`, `Decimal`) is read as a float wherever an operator works on it; it stays a decimal when it only passes through a conditional or `??`.
- `round`, `floor` and `ceil` leave an integer as it is and give a float for a float; `abs` keeps the type of its argument; `length` gives an integer (32-bit, or the language's own size where that differs: Swift, Go, Rust); `toNumber` gives a float.
- The result is converted to the target field's type with the same conversions as a direct relation (`.toBigDecimal()`, `BigDecimal.valueOf(…)`, `(decimal)…`, `Decimal(str(…))`).

JavaScript and TypeScript have a single number type, so their expressions are written as typed. The case `shared/test-cases/generators/expression-numbers` checks these rules in every language.

### Safety

- The expression is **parsed into a tree and translated** by each generator; it is never evaluated in the browser. There is no `eval`, no `new Function` and no dynamic code anywhere in Mapper.
- Anything outside the grammar is an error: `window.alert(1)`, assignments, arrow functions, templates and unknown functions are rejected before reaching any generator.
- Length (2,000 characters) and nesting (40 levels) are limited.
- The checker types the expression against the source fields (`unknownField`, `typeMismatch`) and the result against the target field.

## Validation

`web/src/core/mapping/validate.ts` checks the root mapping and every mapping it uses:

| Severity | Codes |
|---|---|
| error | required field without value, source field that no longer exists, incompatible types, a transformation needed, wrong number of sources, a transformation that does not suit the types, boolean without true values, invalid expression, nested object without mapping, constant of the wrong type |
| warning | null into a required field, conversion that may fail, lossy conversion, enum values without a pair, suggestion or conflict waiting for review |
| info | unused source field, optional field without value, automatic conversion, one source filling several fields |

Errors make the generated code wrong or incomplete; warnings may fail or lose information at run time; information needs no action.
