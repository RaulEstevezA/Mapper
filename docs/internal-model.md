# Internal model

Two structures are shared by every part of Mapper: the **ModelSchema**, which describes models, and the **MappingSet**, which describes how one model fills another. Both are plain JSON values.

## ModelSchema

Defined in `web/src/core/model/schema.ts`. It is also the interchange format with Api2Class and Model2DB ([interoperability.md](interoperability.md)).

```ts
interface ModelSchema {
  format: 'model-schema'
  version: 1
  origin?: { format: string; language?: string; framework?: string; tool?: string }
  models: ModelDef[]
  enums: EnumDef[]
  root?: string
}
```

### Types

```ts
type TypeRef =
  | { kind: 'primitive'; name: Primitive; bits?: 8 | 16 | 32 | 64 }
  | { kind: 'array'; items: TypeRef; itemsNullable?: boolean }
  | { kind: 'map'; key: TypeRef; value: TypeRef }
  | { kind: 'model'; name: string }
  | { kind: 'enum'; name: string }
  | { kind: 'unknown'; name: string }
```

`Primitive` is one of `string`, `integer`, `float`, `decimal`, `boolean`, `date`, `datetime`, `time`, `duration`, `uuid`, `binary`, `any`. Sizes are kept only when the input states them (`int`, `Long`, `f32`); a number without a size (JSON, TypeScript, Python) is compatible with every size.

Every language maps its own names onto these types through a `TypeTable` (`parsers/code/raw.ts`). Examples:

| Common type | Python | Java | C# | TypeScript | Kotlin | Go | Rust |
|---|---|---|---|---|---|---|---|
| integer (32) | `int` | `int`, `Integer` | `int` | `number` | `Int` | `int32` | `i32` |
| decimal | `Decimal` | `BigDecimal` | `decimal` | — | `BigDecimal` | `decimal.Decimal` | `Decimal` |
| datetime | `datetime` | `LocalDateTime`, `Instant`… | `DateTime` | `Date` | `Instant` | `time.Time` | `DateTime<Utc>` |
| array | `list[T]` | `List<T>` | `List<T>` | `T[]` | `List<T>` | `[]T` | `Vec<T>` |

### Fields

```ts
interface FieldDef {
  name: string
  type: TypeRef
  originalType?: string     // as written: Optional[List[str]]
  nullable: boolean         // may hold null
  optional: boolean         // may be missing
  defaultValue?: Literal
  serializedName?: string   // name on the wire or in the database
  aliases?: string[]
  description?: string
  annotations?: Annotation[]
  generated?: boolean       // filled by the database or framework
  metadata?: Record<string, string | number | boolean>
}
```

`nullable` and `optional` are different facts: `string | null` is nullable, `name?: string` is optional, `Optional[str] = None` is both. A target field **needs a value** (`needsValue`) when it is neither, has no default and is not generated.

### Models and enums

`ModelDef` has a name, a kind (`class`, `record`, `struct`, `entity`, `object`…), its fields, the parents it inherits from (`allFields` includes inherited fields), the framework when recognized and the construction style (`named`, `positional`, `properties`) that generators follow. `EnumDef.kind` is `literals` for sets of plain values (`'a' | 'b'`, `Literal[...]`, JSON Schema `enum`) and `enum` for real enum types.

## MappingSet

Defined in `web/src/core/mapping/types.ts`.

```ts
interface MappingSet { root: string; mappings: ModelMapping[] }

interface ModelMapping {
  id: string                // "UserDto->User"
  source: string
  target: string
  fields: FieldMapping[]    // one per target field, in the target's order
  ignoredSources: string[]  // source fields marked as intentionally unused
}

interface FieldMapping {
  target: string
  sources: SourcePath[]     // ['address', 'city']; [] is the whole source object
  transform: Transform
  fallback?: Literal        // used when the source is null or missing
  status: 'active' | 'pending' | 'ignored' | 'unmapped'
  confidence: 'exact' | 'high' | 'probable' | 'review' | 'conflict' | 'none'
  manual?: boolean
  reasons?: Reason[]
  candidates?: Candidate[]
}
```

The mapping is **target-centric**: every target field has exactly one entry, so the generated code builds the target field by field. A nested object or a list of objects points to another `ModelMapping` by id, which becomes its own function in the generated code; recursive models point to themselves.

Statuses:

| Status | Meaning | In the generated code |
|---|---|---|
| active | Part of the mapping | Yes |
| pending | A suggestion to review or a conflict | No |
| ignored | The user decided the field gets no value | No |
| unmapped | Nothing found or chosen | No (a TODO placeholder if the field needs a value) |

The confidence scale is the one in personal_web_style (`patterns/confidence-states.md`): exact, high, likely (probable), review, conflict, no match. Exact, high and probable suggestions are active; review and conflict are pending until the user decides.
