import { failure, positionAt, type InputParser } from '../types.ts'
import type { JsonValue } from './jsonText.ts'
import { fromDataValue } from './json.ts'

// Enough rows to see every kind of value a column holds, without slowing down with a huge file
const MAX_ROWS = 2000
const DELIMITERS = [',', ';', '\t', '|']

/** The delimiter that splits the first line into the most columns. */
function detectDelimiter(firstLine: string): string {
  let best = ','
  let bestCount = 0
  for (const delimiter of DELIMITERS) {
    const count = firstLine.split(delimiter).length - 1
    if (count > bestCount) {
      best = delimiter
      bestCount = count
    }
  }
  return best
}

/** RFC 4180 rows: quoted fields may contain the delimiter, quotes ("") and line breaks. */
export function readCsv(text: string, delimiter: string, maxRows = Infinity): { rows: string[][]; unterminatedAt: number | null } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let quoteStart = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index++
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      quoteStart = index
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      row.push(field)
      field = ''
      if (row.some((cell) => cell !== '') || row.length > 1) rows.push(row)
      row = []
      if (rows.length > maxRows) break
    } else field += char
  }
  if (quoted) return { rows, unterminatedAt: quoteStart }
  row.push(field)
  if (row.some((cell) => cell !== '')) rows.push(row)
  return { rows, unterminatedAt: null }
}

/** A CSV cell as a typed value: CSV is all text, so numbers and booleans are recognized by their look.
 * Numbers with leading zeros (zip codes, phone numbers) stay text. */
export function typedCell(cell: string): JsonValue {
  const value = cell.trim()
  if (value === '') return { kind: 'null' }
  if (/^-?(0|[1-9]\d*)$/.test(value) && value.length < 16) return { kind: 'number', text: value, integer: true }
  if (/^-?(0|[1-9]\d*)\.\d+$/.test(value)) return { kind: 'number', text: value, integer: false }
  if (/^(true|false)$/i.test(value)) return { kind: 'boolean', value: value.toLowerCase() === 'true' }
  return { kind: 'string', value }
}

export const csvParser: InputParser = {
  id: 'csv',
  kind: 'data',
  label: 'CSV',
  extensions: ['.csv', '.tsv'],
  editorLanguage: 'text',
  detect(text) {
    const lines = text.trim().split(/\r?\n/).slice(0, 5)
    if (lines.length < 2 || /^[\s{[<]/.test(text.trimStart()[0] ?? '')) return 0
    const delimiter = detectDelimiter(lines[0])
    const counts = lines.map((line) => line.split(delimiter).length)
    if (counts[0] < 2 || counts.some((count) => count !== counts[0])) return 0
    // Code rarely has every line split into the same number of comma-separated parts, but check for braces
    return /[{};()]/.test(text) ? 0.15 : 0.6
  },
  parse(text, options = {}) {
    if (text.trim() === '') return failure('empty')
    const source = text.startsWith('﻿') ? text.slice(1) : text
    const delimiter = detectDelimiter(source.split(/\r?\n/, 1)[0])
    const { rows, unterminatedAt } = readCsv(source, delimiter, MAX_ROWS + 1)
    if (unterminatedAt !== null) return failure('unterminatedString', positionAt(source, unterminatedAt))
    const [header, ...data] = rows
    if (!header || header.every((cell) => cell.trim() === '')) return failure('noModels')
    const names = header.map((cell, index) => cell.trim() || `column${index + 1}`)
    const objects: JsonValue[] = (data.length > 0 ? data : [names.map(() => '')]).slice(0, MAX_ROWS).map((row) => ({
      kind: 'object',
      entries: names.map((name, index): [string, JsonValue] => [name, typedCell(row[index] ?? '')]),
    }))
    const outcome = fromDataValue({ kind: 'array', items: objects }, options.rootName ?? 'Row', 'csv')
    if (!outcome.ok) return outcome
    // A column that is always empty is still a text column, not a value of unknown shape
    for (const field of outcome.schema.models[0].fields) {
      if (field.type.kind === 'primitive' && field.type.name === 'any') field.type = { kind: 'primitive', name: 'string' }
    }
    if (data.length > MAX_ROWS) outcome.warnings.push({ code: 'truncatedRows', params: { rows: MAX_ROWS } })
    return outcome
  },
}
