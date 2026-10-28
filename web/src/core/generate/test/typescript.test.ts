import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { typeScriptGenerator, javaScriptGenerator } from '../languages/typescript.ts'
import type { GenerateSettings } from '../types.ts'
import { declarations } from './tsDeclarations.ts'
import { prepared } from './helpers.ts'

const settings: GenerateSettings = {
  mode: 'functions',
  naming: 'keep',
  options: { sourceModule: './source-models', targetModule: './target-models' },
}

/** Type-checks files in memory with strict settings and returns the errors. */
function typeCheck(files: Record<string, string>): string[] {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts'],
    skipLibCheck: true,
  }
  const host = ts.createCompilerHost(options)
  const read = host.readFile
  host.fileExists = (name) => name in files || ts.sys.fileExists(name)
  host.directoryExists = (name) => name.startsWith('/project') || ts.sys.directoryExists(name)
  host.getCurrentDirectory = () => '/project'
  host.readFile = (name) => files[name] ?? read(name)
  const getSourceFile = host.getSourceFile
  host.getSourceFile = (name, language) =>
    name in files ? ts.createSourceFile(name, files[name], language) : getSourceFile(name, language)
  const program = ts.createProgram(Object.keys(files), options, host)
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => `${diagnostic.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`)
}

describe('TypeScript generator', () => {
  for (const { example, plan, source, target } of prepared()) {
    it(`generates code that type-checks: ${example.id}`, async () => {
      const output = typeScriptGenerator.generate(plan, settings)
      const code = output.files[0].code
      await expect(code).toMatchFileSnapshot(`__snapshots__/typescript/${example.id}.ts`)
      const errors = typeCheck({
        '/project/mapper.ts': code,
        '/project/source-models.ts': declarations(source),
        '/project/target-models.ts': declarations(target),
      })
      expect(errors).toEqual([])
    })
  }

  it('writes JavaScript with JSDoc', async () => {
    const { plan } = prepared()[0]
    const code = javaScriptGenerator.generate(plan, settings).files[0].code
    await expect(code).toMatchFileSnapshot('__snapshots__/javascript/simple.js')
    expect(code).toContain('@param {UserDto} source')
  })
})
