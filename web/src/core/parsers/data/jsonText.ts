// Adapted from Api2Class (web/src/core/json.ts): the same strict parser, so both tools report JSON errors alike.

/** A parsed JSON value. Numbers keep their text so `29.0` (float) and `29` (integer) stay different,
 * which JSON.parse cannot tell apart. Object entries keep their order, duplicates included. */
export type JsonValue =
  | { kind: 'object'; entries: [string, JsonValue][] }
  | { kind: 'array'; items: JsonValue[] }
  | { kind: 'string'; value: string }
  | { kind: 'number'; text: string; integer: boolean }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }

export type JsonErrorCode =
  | 'empty'
  | 'unexpectedEnd'
  | 'unexpectedCharacter'
  | 'trailingComma'
  | 'invalidNumber'
  | 'invalidEscape'
  | 'controlCharacter'
  | 'trailingContent'
  | 'tooDeep'

/** What the parser was waiting for when it found something else */
export type JsonExpected = 'value' | 'key' | 'colon' | 'commaOrBrace' | 'commaOrBracket'

export interface JsonErrorInfo {
  code: JsonErrorCode
  /** 1-based, counted in characters (code points), the same as the desktop version */
  line: number
  column: number
  /** The offending character, when there is one */
  found?: string
  expected?: JsonExpected
  /** The last property read before the error, to say where it is ("after "email"") */
  key?: string
}

export type ParseResult = { ok: true; value: JsonValue } | { ok: false; error: JsonErrorInfo }

// Deeper documents are almost certainly not API responses, and the limit avoids a stack overflow
export const MAX_DEPTH = 512

interface Context {
  expected?: JsonExpected
  key?: string
}

class JsonError extends Error {
  readonly code: JsonErrorCode
  readonly index: number
  readonly context: Context

  constructor(code: JsonErrorCode, index: number, context: Context) {
    super(code)
    this.code = code
    this.index = index
    this.context = context
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

/** Strict JSON (RFC 8259) parser that reports where the text is wrong. */
export function parseJson(text: string): ParseResult {
  // A byte order mark is invisible when pasting from some editors
  const source = text.startsWith('﻿') ? text.slice(1) : text
  let index = 0

  function skipWhitespace() {
    while (index < source.length && ' \t\n\r'.includes(source[index])) index++
  }

  function fail(code: JsonErrorCode, context: Context = {}): never {
    throw new JsonError(code, index, context)
  }

  function unexpected(context: Context): never {
    fail(index >= source.length ? 'unexpectedEnd' : 'unexpectedCharacter', context)
  }

  function expect(char: string, context: Context) {
    if (source[index] !== char) unexpected(context)
    index++
  }

  function parseValue(depth: number, key?: string): JsonValue {
    if (depth > MAX_DEPTH) fail('tooDeep')
    skipWhitespace()
    const char = source[index]
    if (char === '{') return parseObject(depth)
    if (char === '[') return parseArray(depth, key)
    if (char === '"') return { kind: 'string', value: parseString() }
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber()
    for (const [word, value] of [
      ['true', { kind: 'boolean', value: true }],
      ['false', { kind: 'boolean', value: false }],
      ['null', { kind: 'null' }],
    ] as const) {
      if (source.startsWith(word, index)) {
        index += word.length
        return value
      }
    }
    unexpected({ expected: 'value', key })
  }

  function parseObject(depth: number): JsonValue {
    const entries: [string, JsonValue][] = []
    index++
    skipWhitespace()
    if (source[index] === '}') {
      index++
      return { kind: 'object', entries }
    }
    for (;;) {
      skipWhitespace()
      const previous = entries.at(-1)?.[0]
      if (source[index] === '}' && entries.length > 0) fail('trailingComma', { key: previous })
      if (source[index] !== '"') unexpected({ expected: 'key', key: previous })
      const key = parseString()
      skipWhitespace()
      expect(':', { expected: 'colon', key })
      entries.push([key, parseValue(depth + 1, key)])
      skipWhitespace()
      if (source[index] === ',') {
        index++
        continue
      }
      expect('}', { expected: 'commaOrBrace', key })
      return { kind: 'object', entries }
    }
  }

  function parseArray(depth: number, key?: string): JsonValue {
    const items: JsonValue[] = []
    index++
    skipWhitespace()
    if (source[index] === ']') {
      index++
      return { kind: 'array', items }
    }
    for (;;) {
      skipWhitespace()
      if (source[index] === ']' && items.length > 0) fail('trailingComma', { key })
      items.push(parseValue(depth + 1, key))
      skipWhitespace()
      if (source[index] === ',') {
        index++
        continue
      }
      expect(']', { expected: 'commaOrBracket', key })
      return { kind: 'array', items }
    }
  }

  function parseString(): string {
    index++
    let value = ''
    for (;;) {
      if (index >= source.length) fail('unexpectedEnd')
      const char = source[index]
      if (char === '"') {
        index++
        return value
      }
      if (char < ' ') fail('controlCharacter')
      if (char !== '\\') {
        value += char
        index++
        continue
      }
      index++
      const escape = source[index]
      if (escape === undefined) fail('unexpectedEnd')
      if (escape in ESCAPES) {
        value += ESCAPES[escape]
        index++
      } else if (escape === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 1, index + 5))) {
        value += String.fromCharCode(parseInt(source.slice(index + 1, index + 5), 16))
        index += 5
      } else {
        fail('invalidEscape')
      }
    }
  }

  function parseNumber(): JsonValue {
    NUMBER.lastIndex = index
    const match = NUMBER.exec(source)
    if (!match) fail('invalidNumber')
    index += match[0].length
    // 012, 1., 1e: a number followed by more number characters is malformed, not two values
    if (/[0-9.eE+-]/.test(source[index] ?? '')) fail('invalidNumber')
    return { kind: 'number', text: match[0], integer: match[1] === undefined && match[2] === undefined }
  }

  try {
    skipWhitespace()
    if (index >= source.length) fail('empty')
    const value = parseValue(1)
    skipWhitespace()
    if (index < source.length) fail('trailingContent')
    return { ok: true, value }
  } catch (error) {
    if (!(error instanceof JsonError)) throw error
    return { ok: false, error: errorInfo(source, error) }
  }
}

function errorInfo(source: string, error: JsonError): JsonErrorInfo {
  const before = source.slice(0, error.index)
  const lineStart = before.lastIndexOf('\n') + 1
  const info: JsonErrorInfo = {
    code: error.code,
    line: before.split('\n').length,
    column: Array.from(before.slice(lineStart)).length + 1,
  }
  const found = source.codePointAt(error.index)
  if (found !== undefined && error.code !== 'empty') info.found = String.fromCodePoint(found)
  if (error.context.expected) info.expected = error.context.expected
  if (error.context.key !== undefined) info.key = error.context.key
  return info
}
