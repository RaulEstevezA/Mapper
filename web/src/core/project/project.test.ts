import { describe, expect, it } from 'vitest'
import { suggestMapping } from '../matching/engine.ts'
import { emptySchema, primitive, type ModelSchema } from '../model/schema.ts'
import { parseInput } from '../parsers/registry.ts'
import { createHandoff, isTrustedOrigin, readHandoff, takeIncoming } from './handoff.ts'
import { createProject, projectFileName, readProject } from './project.ts'

const schema = (text: string): ModelSchema => {
  const outcome = parseInput(text, 'typescript')
  if (!outcome.ok) throw new Error('parse')
  return outcome.schema
}

describe('project files', () => {
  const source = schema('interface UserDto { id: number; name: string }')
  const target = schema('interface User { id: number; name: string }')
  const mapping = suggestMapping(source, 'UserDto', target, 'User')
  const project = createProject(
    { format: 'typescript', text: 'interface UserDto { id: number; name: string }', model: 'UserDto', schema: source },
    { format: 'typescript', text: 'interface User { id: number; name: string }', model: 'User', schema: target },
    mapping,
    { generator: 'python', mode: 'functions', naming: 'auto', options: { python: { modelsModule: 'app.models' } } },
    new Date('2026-10-28T12:00:00Z'),
  )

  it('round-trips through JSON', () => {
    const read = readProject(JSON.stringify(project))
    expect(read).toEqual({ ok: true, project })
    expect(projectFileName(project)).toBe('userdto-to-user.mapper.json')
  })

  it('rejects other files, newer versions and damaged projects with the path', () => {
    expect(readProject('not json')).toEqual({ ok: false, error: 'notJson' })
    expect(readProject('{"format":"other"}')).toEqual({ ok: false, error: 'notProject' })
    expect(readProject(JSON.stringify({ ...project, version: 2 }))).toEqual({ ok: false, error: 'newerVersion' })
    const damaged = JSON.parse(JSON.stringify(project))
    damaged.mapping.mappings[0].fields[1].transform = { kind: 'eval' }
    expect(readProject(JSON.stringify(damaged))).toEqual({ ok: false, error: 'invalid', path: '$.mapping.mappings[0].fields[1].transform' })
    const badSchema = JSON.parse(JSON.stringify(project))
    badSchema.target.schema.models[0].fields[0].type = { kind: 'primitive', name: 'money' }
    expect(readProject(JSON.stringify(badSchema))).toMatchObject({ ok: false, path: '$.target.schema.models[0].fields[0].type' })
  })
})

describe('handoff between tools', () => {
  const model: ModelSchema = {
    ...emptySchema({ format: 'json', tool: 'api2class' }),
    models: [{ name: 'Root', kind: 'object', fields: [{ name: 'id', type: primitive('integer'), nullable: false, optional: false }] }],
  }

  it('is taken once from sessionStorage and validated', () => {
    const store = new Map<string, string>([['mapper.incoming', JSON.stringify(createHandoff('api2class', 'source', model, 'Root'))]])
    const storage = { getItem: (key: string) => store.get(key) ?? null, removeItem: (key: string) => void store.delete(key) }
    expect(takeIncoming(storage)).toMatchObject({ from: 'api2class', role: 'source', model: 'Root' })
    expect(takeIncoming(storage)).toBeNull()
  })

  it('rejects anything unexpected', () => {
    expect(readHandoff('{')).toBeNull()
    expect(readHandoff({ ...createHandoff('api2class', 'source', model), from: 'evil' })).toBeNull()
    expect(readHandoff({ ...createHandoff('api2class', 'source', model), schema: { format: 'model-schema' } })).toBeNull()
    expect(readHandoff({ ...createHandoff('api2class', 'source', model), model: 'Missing' })).not.toHaveProperty('model')
  })

  it('trusts only the portfolio and its own origin', () => {
    expect(isTrustedOrigin('https://raulesteveza.github.io', 'http://localhost:5173')).toBe(true)
    expect(isTrustedOrigin('http://localhost:5173', 'http://localhost:5173')).toBe(true)
    expect(isTrustedOrigin('https://evil.example.com', 'https://raulesteveza.github.io')).toBe(false)
  })
})
