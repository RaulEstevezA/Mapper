import type { ModelSchema, TypeRef } from '../../model/schema.ts'
import { asDocumentValues } from '../plan.ts'

/** TypeScript declarations of a schema, only for type-checking generated code in tests. */
export function declarations(original: ModelSchema, rename: (name: string) => string = (name) => name): string {
  // A document's dates are text when read as objects
  const schema = asDocumentValues(original)
  const type = (ref: TypeRef): string => {
    switch (ref.kind) {
      case 'primitive':
        return ['integer', 'float', 'decimal'].includes(ref.name)
          ? 'number'
          : ref.name === 'boolean'
            ? 'boolean'
            : ['datetime', 'date'].includes(ref.name)
              ? 'Date'
              : ref.name === 'any'
                ? 'unknown'
                : ref.name === 'binary'
                  ? 'Uint8Array'
                  : 'string'
      case 'array':
        return `${type(ref.items)}[]`
      case 'map':
        return `Record<string, ${type(ref.value)}>`
      case 'model':
      case 'enum':
        return rename(ref.name)
      case 'unknown':
        return 'unknown'
    }
  }
  const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name))
  const parts = schema.enums.map((item) =>
    item.kind === 'literals'
      ? `export type ${rename(item.name)} = ${item.values.map((value) => JSON.stringify(String(value.value ?? value.name))).join(' | ')}`
      : `export enum ${rename(item.name)} { ${item.values.map((value) => `${key(value.name)} = ${JSON.stringify(String(value.value ?? value.name))}`).join(', ')} }`,
  )
  for (const model of schema.models) {
    const fields = model.fields.map(
      (field) => `  ${key(field.name)}${field.optional ? '?' : ''}: ${type(field.type)}${field.nullable ? ' | null' : ''}`,
    )
    parts.push(
      model.kind === 'class' || model.kind === 'entity'
        ? `export class ${rename(model.name)} {\n${fields.map((line) => line.replace(/^ {2}(\S+?)(\??):/, (_, name, optional) => `  ${name}${optional || '!'}:`)).join('\n')}\n}`
        : `export interface ${rename(model.name)} {\n${fields.join('\n')}\n}`,
    )
  }
  return parts.join('\n\n')
}
