# Matching engine

`web/src/core/matching/engine.ts` proposes, for every target field, the source that most likely gives its value, and says how sure it is. It never resolves an ambiguity: close alternatives are shown as a conflict for the user to decide.

## Candidate sources

For a pair of models, the candidates are every field of the source model and of its nested objects, down to three levels (`customer.address.city`). Lists are not entered: their elements are mapped by a collection. A nested object can also be built from the source itself (a flat source filling a nested target), when at least half of the nested target's fields match.

## Name score

`matching/names.ts` compares names in stages; the first that matches gives the score:

| Score | Rule | Example |
|---|---|---|
| 1.00 | Same name | `email` → `email` |
| 0.97 | Same words in another convention | `createdAt` → `created_at`, `userID` → `user_id` |
| 0.95 | Same name on the wire | `@JsonProperty("user_id")` → `user_id` |
| 0.93 | Abbreviation or compound | `qty` → `quantity`, `surname` → `last_name`, `dob` → `birth_date`, `emailAddress` → `email` |
| 0.88 | Strong synonym | `creationDate` → `created_at`, `given_name` → `first_name` |
| 0.90 / 0.75 | The model name added or removed | `userId` in `UserDto` → `id` (0.90 for keys such as id, code, number) |
| 0.86 | The type name completes the field name | `shipping: AddressApi` → `shippingAddress: Address` |
| 0.74 | Weak synonym | `price` → `cost`, `items` → `lines`, `title` → `name` |
| ≤ 0.85 | Similar names (Dice of words and Jaro-Winkler) | |
| ≤ 0.75 | One name contains the other | `username` → `name` |

Before comparing, names are split into words, abbreviations are expanded, plurals singularized, stop words and trailing temporal words removed (`created_at`, `creation_date` and `createdOn` all mean "created"), and synonyms reduced to a canonical word. Role suffixes of model names (`Dto`, `Entity`, `Request`, `Response`, `Model`…) are ignored.

A nested source field may also match by its own name (`shipping.city` → `city`) at 82% of its score, and every level of nesting multiplies the score by 0.96.

## Type factor

The name score is multiplied by how well the types fit (`model/compatibility.ts`):

| Compatibility | Factor | Example |
|---|---|---|
| same | 1.00 | |
| widening | 0.98 | `int` → `long`, `date` → `datetime` |
| conversion | 0.85 – 0.90 | `int` → `string`, `float` → `int` (lossy) |
| conversion that may fail | 0.88 | `"123"` → `123`, ISO text → date |
| transformation needed | 0.60 | text → boolean, number → date |
| nested objects | 0.60 + 0.40 × share of the target's fields matched | |
| enums | 0.60 + 0.40 × share of values paired | |
| incompatible | rejected | object → number, list → text |

A source that may be null going into a field that cannot is multiplied by 0.97.

## Confidence

| Score | Confidence | Default status |
|---|---|---|
| ≥ 0.99 | exact | active |
| ≥ 0.85 | high | active |
| ≥ 0.70 | probable | active |
| ≥ 0.50 | review | pending |
| < 0.50 | none | unmapped |

## Assignment and ambiguity

All (target, candidate) pairs are sorted by score and assigned greedily, each source used once. Before assigning a pair that is not exact, the engine looks for:

- another source almost as good for the same target (less than 0.06 apart), or
- another undecided target that wants the same source almost as much.

In both cases every party is marked as a **conflict**: pending, with its candidates, and nothing is applied. Derived values (a part of a text, a flag from a status) do not use their source up, so `firstName` and `lastName` can both come from `fullName`, and `active` from `status` while `status` is mapped too.

## Combined suggestions

Besides one-to-one relations, the engine proposes:

- **Concatenation:** a full or display name from first and last name.
- **Split:** first or last name from a full name (always for review).
- **Cents:** `price_cents` → `price` divided by 100.
- **Boolean from a status:** `active` from `status`, true for values such as ACTIVE or ENABLED (for review).
- **Epoch:** a number into a date and back (seconds by default).
- **Enum values:** paired by name or wire value, ignoring case and separators.

## Nested mappings

When a relation is a nested object or a list of objects, the engine creates (once) the mapping of that pair of models and suggests its fields the same way. Recursive models end because a mapping is registered before its fields are suggested.

## Keeping the user's decisions

When an input changes, `reconcile` (`app/workspace.ts`) asks the engine again and keeps every manual decision, ignored field and accepted review whose target field and sources still exist.
