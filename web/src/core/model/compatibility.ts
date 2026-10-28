import type { Primitive, TypeRef } from './schema.ts'

/** How a source value can become a target value.
 * - same: assigned as is.
 * - widening: assigned as is or with a cast that never loses information (int → long, date → datetime).
 * - conversion: needs a conversion the generators write automatically ("123" → 123, 12 → "12").
 * - transform: needs a transformation the user chooses (epoch seconds → datetime, string → boolean).
 * - nested: two models; mapped with another model mapping.
 * - collection: two collections; mapped element by element (`items` says how).
 * - incompatible: there is no sensible way (an object into a number). */
export type CompatibilityLevel = 'same' | 'widening' | 'conversion' | 'transform' | 'nested' | 'collection' | 'incompatible'

export interface Compatibility {
  level: CompatibilityLevel
  /** The conversion may fail at run time (parsing a number from text) */
  fallible?: boolean
  /** The conversion may lose information (float → integer, datetime → date) */
  lossy?: boolean
  /** For collections: compatibility of the elements (or of map values) */
  items?: Compatibility
}

const NUMBERS: ReadonlySet<Primitive> = new Set(['integer', 'float', 'decimal'])
const PARSED_FROM_TEXT: ReadonlySet<Primitive> = new Set(['integer', 'float', 'decimal', 'date', 'datetime', 'time', 'duration', 'uuid'])

function primitiveCompatibility(
  source: Extract<TypeRef, { kind: 'primitive' }>,
  target: Extract<TypeRef, { kind: 'primitive' }>,
): Compatibility {
  const from = source.name
  const to = target.name
  if (to === 'any') return { level: 'same' }
  if (from === 'any') return { level: 'conversion', fallible: true }
  if (from === to) {
    if (from === 'integer' || from === 'float') {
      const sourceBits = source.bits ?? 64
      const targetBits = target.bits ?? 64
      if (sourceBits === targetBits) return { level: 'same' }
      return sourceBits < targetBits ? { level: 'widening' } : { level: 'conversion', lossy: true }
    }
    return { level: 'same' }
  }
  if (NUMBERS.has(from) && NUMBERS.has(to)) {
    if (from === 'integer') return { level: 'widening' }
    // float ↔ decimal changes the representation; float/decimal → integer drops the decimals
    return to === 'integer' ? { level: 'conversion', lossy: true } : { level: 'conversion' }
  }
  if (to === 'string') return from === 'binary' ? { level: 'transform' } : { level: 'conversion' }
  if (from === 'string') {
    if (PARSED_FROM_TEXT.has(to)) return { level: 'conversion', fallible: true }
    // Booleans ("yes", "Y", "ACTIVE": only the user knows which texts mean true) and binary data
    return { level: 'transform' }
  }
  if (from === 'date' && to === 'datetime') return { level: 'widening' }
  if (from === 'datetime' && (to === 'date' || to === 'time')) return { level: 'conversion', lossy: true }
  if (from === 'boolean' && to === 'integer') return { level: 'conversion' }
  if (from === 'integer' && to === 'boolean') return { level: 'transform' }
  // Epoch seconds or milliseconds: the unit has to be chosen
  if (from === 'integer' && (to === 'datetime' || to === 'date')) return { level: 'transform' }
  if ((from === 'datetime' || from === 'date') && to === 'integer') return { level: 'transform' }
  return { level: 'incompatible' }
}

/** Compatibility of assigning a value of `source` type to a field of `target` type, ignoring nullability. */
export function compatibility(source: TypeRef, target: TypeRef): Compatibility {
  if (target.kind === 'primitive' && target.name === 'any') return { level: 'same' }

  if (source.kind === 'array' || target.kind === 'array') {
    if (source.kind === 'array' && target.kind === 'array') {
      const items = compatibility(source.items, target.items)
      return items.level === 'incompatible' ? { level: 'incompatible', items } : { level: 'collection', items }
    }
    return { level: 'incompatible' }
  }

  if (source.kind === 'map' || target.kind === 'map') {
    if (source.kind === 'map' && target.kind === 'map') {
      const items = compatibility(source.value, target.value)
      return items.level === 'incompatible' ? { level: 'incompatible', items } : { level: 'collection', items }
    }
    return { level: 'incompatible' }
  }

  if (source.kind === 'model' || target.kind === 'model') {
    if (source.kind === 'model' && target.kind === 'model') return source.name === target.name ? { level: 'same' } : { level: 'nested' }
    if (source.kind === 'primitive' && source.name === 'any') return { level: 'conversion', fallible: true }
    return { level: 'incompatible' }
  }

  if (source.kind === 'enum' || target.kind === 'enum') {
    if (source.kind === 'enum' && target.kind === 'enum') {
      // Different enums need their values related; the validation checks they all are
      return source.name === target.name ? { level: 'same' } : { level: 'transform' }
    }
    const other = source.kind === 'enum' ? target : source
    if (other.kind === 'primitive' && (other.name === 'string' || other.name === 'integer')) {
      // Enum → text is safe; text → enum fails for unknown values
      return source.kind === 'enum' ? { level: 'conversion' } : { level: 'conversion', fallible: true }
    }
    if (other.kind === 'primitive' && other.name === 'any') return { level: 'conversion', fallible: true }
    return { level: 'incompatible' }
  }

  if (source.kind === 'unknown' || target.kind === 'unknown') {
    if (source.kind === 'unknown' && target.kind === 'unknown' && source.name === target.name) return { level: 'same' }
    // Types declared elsewhere: nothing can be checked, the user decides
    return { level: 'transform' }
  }

  return primitiveCompatibility(source, target)
}

/** Whether a value of this compatibility can be assigned without a user-chosen transformation. */
export function assignable(result: Compatibility): boolean {
  if (result.level === 'collection') return result.items ? assignable(result.items) : false
  return result.level === 'same' || result.level === 'widening' || result.level === 'conversion' || result.level === 'nested'
}
