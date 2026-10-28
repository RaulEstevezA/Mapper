import type { ModelSchema } from '../model/schema.ts'

/** Every input Mapper can read. Data formats (JSON, YAML, XML, CSV) describe models through an example
 * document; schema formats and code declare them. */
export type InputFormatId =
  | 'json'
  | 'yaml'
  | 'xml'
  | 'csv'
  | 'jsonschema'
  | 'openapi'
  | 'graphql'
  | 'protobuf'
  | 'prisma'
  | 'modelschema'
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'csharp'
  | 'kotlin'
  | 'dart'
  | 'swift'
  | 'go'
  | 'rust'
  | 'php'

export type InputKind = 'data' | 'schema' | 'code'

/** A problem found while reading the input. Codes are translated by the interface (i18n/messages.ts);
 * `params` fill in the details (the token found, the type that was not recognized...). */
export interface ParseIssue {
  code: IssueCode
  /** 1-based position, when the issue is at a specific place */
  line?: number
  column?: number
  params?: Record<string, string | number>
}

export type IssueCode =
  /** Nothing to read */
  | 'empty'
  /** Not valid in the format: `params.detail` is a code of the format's own errors (JSON) or a message */
  | 'syntax'
  | 'unexpectedToken'
  | 'unterminatedString'
  | 'unterminatedComment'
  | 'unclosedBlock'
  /** Valid, but nothing that describes a model was found */
  | 'noModels'
  /** Warnings */
  | 'unknownType'
  | 'mixedTypes'
  | 'duplicateField'
  | 'duplicateModel'
  | 'emptyModel'
  | 'truncatedRows'

export type ParseOutcome = { ok: true; schema: ModelSchema; warnings: ParseIssue[] } | { ok: false; error: ParseIssue }

export interface ParseOptions {
  /** Name for the root model of data formats, which have no name of their own */
  rootName?: string
}

export interface InputParser {
  id: InputFormatId
  kind: InputKind
  /** Shown in the format selector */
  label: string
  /** File extensions it reads, with the dot */
  extensions: readonly string[]
  /** Highlighting used by the editor (utils/editorLanguages.ts) */
  editorLanguage: string
  /** How likely it is that the text is in this format, from 0 (not at all) to 1 (certain). Cheap: it
   * looks for telltale syntax and does not parse the whole text. */
  detect(text: string): number
  parse(text: string, options?: ParseOptions): ParseOutcome
}

export function failure(code: IssueCode, position?: { line: number; column: number }, params?: ParseIssue['params']): ParseOutcome {
  return { ok: false, error: { code, ...position, ...(params ? { params } : {}) } }
}

/** 1-based line and column of an index of the text, counted in characters. */
export function positionAt(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index)
  const lineStart = before.lastIndexOf('\n') + 1
  return { line: before.split('\n').length, column: Array.from(before.slice(lineStart)).length + 1 }
}
