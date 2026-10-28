import { allFields, findModel, type FieldDef, type ModelSchema, type TypeRef } from '../model/schema.ts'
import type { SourcePath } from './types.ts'

export interface ResolvedPath {
  type: TypeRef
  /** The value may be null or missing: the field itself, or any object on the way to it */
  nullable: boolean
  /** Fields from the model to the value, one per step */
  steps: FieldDef[]
}

/** Type of the value at a path of a model, or null when some step does not exist. `[]` is the model
 * itself. */
export function resolvePath(schema: ModelSchema, modelName: string, path: SourcePath): ResolvedPath | null {
  if (path.length === 0)
    return findModel(schema, modelName) ? { type: { kind: 'model', name: modelName }, nullable: false, steps: [] } : null
  let model = findModel(schema, modelName)
  const steps: FieldDef[] = []
  let nullable = false
  for (const part of path) {
    if (!model) return null
    const field = allFields(schema, model).find((item) => item.name === part)
    if (!field) return null
    steps.push(field)
    nullable = nullable || field.nullable || field.optional
    model = field.type.kind === 'model' ? findModel(schema, field.type.name) : undefined
  }
  return { type: steps[steps.length - 1].type, nullable, steps }
}

/** The type at the bottom of arrays and maps (`Order[]` → `Order`). */
export function elementType(type: TypeRef): TypeRef {
  if (type.kind === 'array') return elementType(type.items)
  if (type.kind === 'map') return elementType(type.value)
  return type
}
