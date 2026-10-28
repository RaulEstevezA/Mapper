import { parseDocument } from 'yaml'
import { failure, type InputParser, type ParseOutcome } from '../types.ts'
import { fromPlainValue } from './infer.ts'
import { fromDataValue } from './json.ts'

// `key: value` at the start of a line, or `- item`
const MAPPING_LINE = /^[ \t]*(?:- )?[\w"'][\w .\-"']*:(?:[ \t]|$)/m

/** Reads a YAML document as a plain value. Errors carry the position of the first problem. */
export function readYaml(text: string): { ok: true; value: unknown } | { ok: false; outcome: ParseOutcome } {
  if (text.trim() === '') return { ok: false, outcome: failure('empty') }
  const document = parseDocument(text, { prettyErrors: false, uniqueKeys: false })
  const error = document.errors[0]
  if (error) {
    const position = error.linePos?.[0]
    const message = error.message.split('\n')[0]
    return { ok: false, outcome: failure('syntax', position ? { line: position.line, column: position.col } : undefined, { message }) }
  }
  return { ok: true, value: document.toJS({ maxAliasCount: 1000 }) }
}

/** A YAML document used as an example of the model (configuration, fixtures). */
export const yamlParser: InputParser = {
  id: 'yaml',
  kind: 'data',
  label: 'YAML',
  extensions: ['.yaml', '.yml'],
  editorLanguage: 'yaml',
  detect(text) {
    const trimmed = text.trimStart()
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<')) return 0
    if (trimmed.startsWith('---')) return 0.7
    // Code also has `name: type` lines; braces and semicolons give it away
    if (/[{};]\s*$/m.test(text)) return 0.1
    return MAPPING_LINE.test(text) ? 0.5 : 0
  },
  parse(text, options = {}) {
    const read = readYaml(text)
    if (!read.ok) return read.outcome
    return fromDataValue(fromPlainValue(read.value), options.rootName ?? 'Root', 'yaml')
  },
}
