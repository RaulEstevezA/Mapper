import { csvParser } from './data/csv.ts'
import { jsonParser } from './data/json.ts'
import { xmlParser } from './data/xml.ts'
import { yamlParser } from './data/yaml.ts'
import { cSharpParser } from './code/csharp.ts'
import { dartParser } from './code/dart.ts'
import { goParser } from './code/go.ts'
import { javaParser } from './code/java.ts'
import { kotlinParser } from './code/kotlin.ts'
import { phpParser } from './code/php.ts'
import { pythonParser } from './code/python.ts'
import { rustParser } from './code/rust.ts'
import { scalaParser } from './code/scala.ts'
import { swiftParser } from './code/swift.ts'
import { javaScriptParser, typeScriptParser } from './code/typescript.ts'
import { graphQlParser } from './schema/graphql.ts'
import { jsonSchemaParser } from './schema/jsonSchema.ts'
import { modelSchemaParser } from './schema/modelSchema.ts'
import { openApiParser } from './schema/openapi.ts'
import { prismaParser } from './schema/prisma.ts'
import { protobufParser } from './schema/protobuf.ts'
import { smithyParser } from './schema/smithy.ts'
import type { InputFormatId, InputParser, ParseOptions, ParseOutcome } from './types.ts'

/** Every parser, in the order the format selector shows them. Adding a format means adding it here. */
export const parsers: readonly InputParser[] = [
  jsonParser,
  jsonSchemaParser,
  openApiParser,
  yamlParser,
  xmlParser,
  csvParser,
  graphQlParser,
  protobufParser,
  prismaParser,
  modelSchemaParser,
  typeScriptParser,
  javaScriptParser,
  pythonParser,
  javaParser,
  cSharpParser,
  kotlinParser,
  dartParser,
  swiftParser,
  goParser,
  rustParser,
  phpParser,
  scalaParser,
  smithyParser,
]

export function findParser(id: InputFormatId): InputParser | undefined {
  return parsers.find((parser) => parser.id === id)
}

export interface Detection {
  id: InputFormatId
  score: number
}

// Below this, a guess would be wrong more often than right: the user chooses
const MIN_SCORE = 0.3

/** Formats the text may be in, most likely first. A file name with a known extension decides it. */
export function detectFormats(text: string, fileName?: string): Detection[] {
  const lower = fileName?.toLowerCase() ?? ''
  const sample = text.length > 20000 ? text.slice(0, 20000) : text
  return parsers
    .map((parser) => {
      let score = parser.detect(sample)
      // The longest matching extension wins: `.schema.json` over `.json`
      const extension = parser.extensions.filter((item) => lower.endsWith(item)).sort((a, b) => b.length - a.length)[0]
      if (extension) score = Math.max(score, 0.9) + extension.length / 100
      return { id: parser.id, score }
    })
    .filter((detection) => detection.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
}

export function detectFormat(text: string, fileName?: string): InputFormatId | null {
  return detectFormats(text, fileName)[0]?.id ?? null
}

export function parseInput(text: string, format: InputFormatId, options?: ParseOptions): ParseOutcome {
  const parser = findParser(format)
  if (!parser) return { ok: false, error: { code: 'syntax', params: { message: `Unknown format ${format}` } } }
  if (text.trim() === '') return { ok: false, error: { code: 'empty' } }
  try {
    return parser.parse(text, options)
  } catch (error) {
    // A parser bug must never break the page: report it as an input the format cannot read
    return { ok: false, error: { code: 'syntax', params: { message: error instanceof Error ? error.message : String(error) } } }
  }
}

/** File extensions accepted by the file picker: only those of formats that can really be read. */
export function acceptedExtensions(): string[] {
  return [...new Set(parsers.flatMap((parser) => parser.extensions))]
}
