import { toCamelCase } from '../../model/naming.ts'
import { allFields, type FieldDef, type ModelDef, type ModelSchema, type TypeRef } from '../../model/schema.ts'

/** Java declarations of a schema (package-private, one file), only for compiling generated code in tests. */
export function javaDeclarations(schema: ModelSchema): string {
  const fromJava = schema.origin?.language === 'java'
  const type = (field: FieldDef | null, ref: TypeRef, boxed = false): string => {
    if (field && fromJava && field.originalType) return field.originalType
    switch (ref.kind) {
      case 'primitive': {
        const nullable = boxed || (field?.nullable ?? false)
        switch (ref.name) {
          case 'string':
            return 'String'
          case 'integer':
            return ref.bits === 32 ? (nullable ? 'Integer' : 'int') : nullable ? 'Long' : 'long'
          case 'float':
            return nullable ? 'Double' : 'double'
          case 'decimal':
            return 'java.math.BigDecimal'
          case 'boolean':
            return nullable ? 'Boolean' : 'boolean'
          case 'datetime':
            return 'java.time.OffsetDateTime'
          case 'date':
            return 'java.time.LocalDate'
          case 'time':
            return 'java.time.LocalTime'
          case 'uuid':
            return 'java.util.UUID'
          case 'duration':
            return 'java.time.Duration'
          case 'binary':
            return 'byte[]'
          default:
            return 'Object'
        }
      }
      case 'array':
        return `java.util.List<${type(null, ref.items, true)}>`
      case 'map':
        return `java.util.Map<String, ${type(null, ref.value, true)}>`
      default:
        return ref.name
    }
  }
  const capital = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)
  // The same names the generator uses: as written in Java, camelCase otherwise
  const name = (field: FieldDef) => (fromJava ? field.name : toCamelCase(field.name))
  const declare = (model: ModelDef): string => {
    const fields = allFields(schema, model)
    const nested = schema.models.filter((item) => item.metadata?.outer === model.name).map((item) => `static ${declare(item)}`)
    if (model.kind === 'record')
      return `record ${model.name}(${fields.map((field) => `${type(field, field.type)} ${name(field)}`).join(', ')}) {}`
    const members: string[] = []
    const publicFields = model.metadata?.accessors === 'fields'
    for (const field of fields) {
      const fieldType = type(field, field.type)
      const fieldName = name(field)
      members.push(`  ${publicFields ? 'public' : 'private'} ${fieldType} ${fieldName};`)
      if (!publicFields) {
        const getter = fieldType === 'boolean' && fromJava ? 'is' : 'get'
        members.push(`  public ${fieldType} ${getter}${capital(fieldName)}() { return ${fieldName}; }`)
        members.push(`  public void set${capital(fieldName)}(${fieldType} value) { this.${fieldName} = value; }`)
      }
    }
    if (model.metadata?.builder) {
      members.push(`  public static Builder builder() { return new Builder(); }`)
      members.push(
        `  public static class Builder {\n    private final ${model.name} built = new ${model.name}();\n${fields.map((field) => `    public Builder ${name(field)}(${type(field, field.type)} value) { built.${name(field)} = value; return this; }`).join('\n')}\n    public ${model.name} build() { return built; }\n  }`,
      )
    }
    return `class ${model.name} {\n${[...members, ...nested].join('\n')}\n}`
  }
  const parts = schema.enums.map(
    (item) =>
      `enum ${item.name} { ${item.values.map((value) => (/^[A-Za-z_]\w*$/.test(value.name) && !(item.kind === 'literals' && /[a-z]/.test(value.name)) ? value.name : value.name.toUpperCase().replace(/\W/g, '_'))).join(', ')} }`,
  )
  for (const model of schema.models) if (!model.metadata?.outer) parts.push(declare(model))
  return ['import java.math.*;', 'import java.time.*;', 'import java.util.*;', ...parts].join('\n\n')
}
