# Interoperability

Mapper works alone, and can also receive models from Api2Class and send them to DBCreate. Three formats make it possible.

| Format | What it holds | Used for |
|---|---|---|
| `model-schema` | Models: fields, types, nullability, enums | Exchanging models between tools, exporting the target model |
| `model-handoff` | One model-schema plus who sent it and which side it fills | Opening a model in another tool |
| `mapper-project` | Both inputs, their models, the mapping and the output settings | Saving and reopening work |

## model-schema (version 1)

The `ModelSchema` described in [internal-model.md](internal-model.md), serialized as JSON. Mapper reads it as an input format (`.model.json`, or any JSON with `"format": "model-schema"`) and validates it field by field (`parsers/schema/modelSchema.ts`), rejecting anything unexpected with the path of the problem.

```json
{
  "format": "model-schema",
  "version": 1,
  "origin": { "format": "json", "tool": "api2class" },
  "root": "Order",
  "models": [
    {
      "name": "Order",
      "kind": "object",
      "fields": [
        { "name": "id", "type": { "kind": "primitive", "name": "integer" }, "nullable": false, "optional": false },
        { "name": "items", "type": { "kind": "array", "items": { "kind": "model", "name": "Item" } }, "nullable": false, "optional": false }
      ]
    }
  ],
  "enums": []
}
```

Rules for producers: model and enum names are unique; references (`model`, `enum`) point to names in the same document; `serializedName` is set when the name on the wire differs from the field name. Consumers ignore properties they do not know, so the format can grow within version 1; a breaking change means version 2.

## model-handoff (version 1)

```json
{
  "format": "model-handoff",
  "version": 1,
  "from": "api2class",
  "role": "source",
  "model": "Order",
  "schema": { "format": "model-schema", "version": 1, "models": [], "enums": [] },
  "text": { "format": "json", "content": "{ … the original JSON … }" }
}
```

`role` says which side of Mapper it fills. `text` is optional: when present it is shown in the input editor (and parsed again), otherwise the model-schema itself is shown.

### Transfer, by order of preference

1. **Same tab, same origin** (every tool is published under `raulesteveza.github.io`): the sender stores the handoff in `sessionStorage` under the receiver's key and navigates to it. The receiver reads it once and removes it.
2. **Another tab:** `window.open` and `postMessage` with the handoff as the message; the receiver only accepts messages from `https://raulesteveza.github.io` or its own origin, and validates the content.
3. **File:** the user exports the model (`.model.json`) and opens it in the other tool.

The URL is never used: models can be large and would stay in the browser history.

## Api2Class → Mapper

What Api2Class needs to add (an "Open in Mapper" action next to Copy and Download, as described in personal_web_style `patterns/tool-continuity.md`):

```ts
// Api2Class: convert its schema to a model-schema, then
const handoff = { format: 'model-handoff', version: 1, from: 'api2class', role: 'source', model: rootName, schema, text: { format: 'json', content: json } }
sessionStorage.setItem('mapper.incoming', JSON.stringify(handoff))
window.location.href = '/tools/Mapper/'
```

Conversion from Api2Class's internal schema (`web/src/core/schema.ts` there):

| Api2Class | model-schema |
|---|---|
| `ClassDef.name`, `fields` | `ModelDef.name`, `fields` (kind `object`) |
| `Field.key` / `Field.name` | `FieldDef.name` = the property name chosen in Api2Class; `serializedName` = the JSON key when they differ |
| primitive `string`, `integer`, `float`, `boolean`, `date`, `datetime`, `uuid`, `any` | the same primitive |
| primitive `object` | `map` of string to `any` |
| primitive `null` | `any` with `nullable: true` |
| `array` with `itemsNullable` | `array` with `itemsNullable` |
| `class` (by `classId`) | `model` with the class name |
| `optional`, `nullable` | `optional`, `nullable` |

Until that action exists, the classes Api2Class generates can be pasted or opened in Mapper as they are: Mapper reads every language and style Api2Class writes (Python, Java, TypeScript with or without Zod, C#, Kotlin, Dart, Swift, Go, PHP, Rust, Scala, JSON Schema and Smithy).

Mapper then opens with the source filled, says "Model received from Api2Class" and moves to the target, the only thing left to provide.

## Mapper → DBCreate

DBCreate does not exist yet, so Mapper only prepares the contract:

- **Export target model** (project bar) downloads the target as a model-schema.
- When DBCreate exists, an "Open in DBCreate" action will send `{ format: 'model-handoff', from: 'mapper', role: 'target', schema: <target model-schema> }` to `sessionStorage['dbcreate.incoming']` and navigate to `/tools/DBCreate/`. DBCreate decides everything about tables and persistence; Mapper sends only the model.

## mapper-project (version 1)

```json
{
  "format": "mapper-project",
  "version": 1,
  "savedAt": "2026-10-28T12:00:00.000Z",
  "source": { "format": "typescript", "text": "…", "model": "UserDto", "schema": { "format": "model-schema", "…": "…" } },
  "target": { "format": "python", "text": "…", "model": "User", "schema": { "…": "…" } },
  "mapping": { "root": "UserDto->User", "mappings": [] },
  "output": { "generator": "python", "mode": "functions", "naming": "auto", "options": { "python": { "modelsModule": "app.models" } } }
}
```

The schemas are stored with the texts so the mapping matches them even if a future parser reads the text differently. Reading a project validates every part (`core/project/project.ts`): a damaged file is rejected with the path of the first problem, and a project from a newer version is refused instead of being misread.

"Remember in this browser" stores the same project in `localStorage['mapper.workspace']`, only while the option is on; "Delete saved work" removes it.
