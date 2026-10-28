import { describe, expect, it } from 'vitest'
import { suggestMapping } from '../matching/engine.ts'
import { parseInput } from '../parsers/registry.ts'
import type { InputFormatId } from '../parsers/types.ts'
import type { ModelSchema } from '../model/schema.ts'
import {
  acceptAllReviews,
  acceptCandidate,
  chooseSources,
  ignoreTarget,
  pruneMappings,
  rejectSuggestion,
  resetField,
  setFallback,
  setTransform,
  toggleIgnoredSource,
} from './edit.ts'
import { findMapping } from './types.ts'
import { validateMapping, type Diagnostic } from './validate.ts'

function schema(text: string, format: InputFormatId = 'typescript'): ModelSchema {
  const outcome = parseInput(text, format)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
  return outcome.schema
}

const codes = (diagnostics: Diagnostic[]) =>
  diagnostics.map((item) => `${item.severity}:${item.code}${item.target ? `:${item.target}` : ''}`)

const SOURCE = schema(`interface UserDto {
  id: number
  firstName: string
  lastName: string
  nickname: string | null
  status: Status
  age: string
  address: AddressDto
  legacyCode: string
}
interface AddressDto { street: string; city: string }
enum Status { ACTIVE = 'active', BLOCKED = 'blocked', PENDING = 'pending' }`)

const TARGET = schema(`interface User {
  id: number
  fullName: string
  nickname: string
  state: State
  age: number
  address: Address
  createdBy: string
  note?: string
}
interface Address { street: string; city: string }
enum State { Active, Blocked }`)

describe('validation', () => {
  it('reports what is wrong, what may fail and what to know', () => {
    const set = suggestMapping(SOURCE, 'UserDto', TARGET, 'User')
    const diagnostics = validateMapping(set, SOURCE, TARGET)
    expect(codes(diagnostics)).toEqual(
      expect.arrayContaining([
        'error:requiredMissing:createdBy',
        'warning:nullToRequired:nickname',
        'warning:fallibleConversion:age',
        'info:optionalUnmapped:note',
        'info:unusedSource',
      ]),
    )
    expect(diagnostics.filter((item) => item.code === 'unusedSource').map((item) => item.params?.field)).toEqual(['status', 'legacyCode'])
    // Errors come first
    expect(diagnostics[0].severity).toBe('error')
  })

  it('checks transformations', () => {
    let set = suggestMapping(SOURCE, 'UserDto', TARGET, 'User')
    const id = set.root
    set = chooseSources(set, SOURCE, TARGET, id, 'state', [['status']])
    expect(findMapping(set, id)!.fields[3].transform).toEqual({
      kind: 'enum',
      pairs: [
        { from: 'ACTIVE', to: 'Active' },
        { from: 'BLOCKED', to: 'Blocked' },
      ],
    })
    expect(codes(validateMapping(set, SOURCE, TARGET))).toContain('warning:enumIncomplete:state')
    set = setTransform(set, id, 'state', { kind: 'enum', pairs: [{ from: 'ACTIVE', to: 'Active' }], fallback: 'Blocked' })
    expect(codes(validateMapping(set, SOURCE, TARGET))).not.toContain('warning:enumIncomplete:state')

    set = setTransform(set, id, 'createdBy', { kind: 'constant', value: 'mapper' })
    expect(codes(validateMapping(set, SOURCE, TARGET))).not.toContain('error:requiredMissing:createdBy')
    set = setTransform(set, id, 'age', { kind: 'constant', value: 'old' })
    expect(codes(validateMapping(set, SOURCE, TARGET))).toContain('error:constantType:age')
    set = setTransform(set, id, 'age', { kind: 'expression', expression: 'toNumber(age) +' })
    expect(validateMapping(set, SOURCE, TARGET).find((item) => item.code === 'invalidExpression')?.expressionError).toMatchObject({
      code: 'unexpectedToken',
    })
    set = setTransform(set, id, 'age', { kind: 'expression', expression: 'upper(age)' })
    expect(codes(validateMapping(set, SOURCE, TARGET))).toContain('error:transformType:age')
    set = chooseSources(set, SOURCE, TARGET, id, 'fullName', [['firstName']])
    set = setTransform(set, id, 'fullName', { kind: 'concat', separator: ' ' })
    expect(codes(validateMapping(set, SOURCE, TARGET))).toContain('error:sourceCount:fullName')
  })

  it('accepts fallbacks for nullable sources and required fields', () => {
    let set = suggestMapping(SOURCE, 'UserDto', TARGET, 'User')
    set = setFallback(set, set.root, 'nickname', '')
    expect(codes(validateMapping(set, SOURCE, TARGET))).not.toContain('warning:nullToRequired:nickname')
  })
})

describe('editing', () => {
  it('chooses sources with the transformation their types need', () => {
    let set = suggestMapping(SOURCE, 'UserDto', TARGET, 'User')
    set = rejectSuggestion(set, set.root, 'address')
    expect(findMapping(set, set.root)!.fields[5].status).toBe('unmapped')
    set = chooseSources(set, SOURCE, TARGET, set.root, 'address', [['address']])
    expect(findMapping(set, set.root)!.fields[5]).toMatchObject({
      transform: { kind: 'object', mapping: 'AddressDto->Address' },
      status: 'active',
      manual: true,
    })
    set = chooseSources(set, SOURCE, TARGET, set.root, 'createdBy', [['firstName'], ['lastName']])
    expect(findMapping(set, set.root)!.fields[6].transform).toEqual({ kind: 'concat', separator: ' ' })
  })

  it('accepts, ignores, resets and keeps sets immutable', () => {
    const original = suggestMapping(SOURCE, 'UserDto', TARGET, 'User')
    const before = JSON.stringify(original)
    let set = ignoreTarget(original, original.root, 'createdBy')
    expect(JSON.stringify(original)).toBe(before)
    expect(findMapping(set, set.root)!.fields[6].status).toBe('ignored')
    set = resetField(set, SOURCE, TARGET, set.root, 'createdBy')
    expect(findMapping(set, set.root)!.fields[6].status).toBe('unmapped')
    set = toggleIgnoredSource(set, set.root, ['legacyCode'])
    const unused = validateMapping(set, SOURCE, TARGET).filter((item) => item.code === 'unusedSource')
    expect(unused.map((item) => item.params?.field)).toEqual(['status'])
  })

  it('accepts pending suggestions and prunes unused nested mappings', () => {
    const source = schema('interface A { fullName: string; extra: { x: string } }')
    const target = schema('interface B { firstName: string; lastName: string; extra: X }\ninterface X { x: string }')
    let set = suggestMapping(source, 'A', target, 'B')
    expect(findMapping(set, set.root)!.fields.map((field) => field.status)).toEqual(['pending', 'pending', 'active'])
    set = acceptAllReviews(set, set.root)
    expect(findMapping(set, set.root)!.fields.map((field) => field.status)).toEqual(['active', 'active', 'active'])
    set = acceptCandidate(set, set.root, 'firstName')
    set = rejectSuggestion(set, set.root, 'extra')
    expect(set.mappings).toHaveLength(2)
    // The rejected field still has its suggestion, so its mapping is kept until nothing refers to it
    expect(pruneMappings(set).mappings).toHaveLength(2)
    const cleared = {
      ...set,
      mappings: set.mappings.map((mapping) => ({ ...mapping, fields: mapping.fields.map((field) => ({ ...field, candidates: [] })) })),
    }
    expect(pruneMappings(cleared).mappings).toHaveLength(1)
  })
})
