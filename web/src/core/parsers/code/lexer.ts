/** A small configurable tokenizer for the declaration languages Mapper reads (code, GraphQL, Protocol
 * Buffers, Prisma). It never runs anything: it only splits the text into identifiers, numbers, strings
 * and punctuation, skipping comments, so the parsers can look for declarations. */

export type TokenKind = 'ident' | 'number' | 'string' | 'punct'

export interface Token {
  kind: TokenKind
  /** For strings, the content without quotes (escapes resolved); otherwise the text as written */
  value: string
  start: number
  end: number
  line: number
  column: number
  /** First token of its line (for indentation-based languages and line-based declarations) */
  lineStart: boolean
  /** Comment right before the token, without the comment markers: the documentation of a declaration */
  doc?: string
  /** The same comment with its markers and tags (`@type {string}`), for JSDoc */
  docRaw?: string
}

export interface StringRule {
  open: string
  close: string
  /** Backslash escapes (`\"`) are allowed */
  escapes: boolean
  multiline: boolean
}

export interface LexerConfig {
  lineComments: readonly string[]
  blockComments: readonly (readonly [string, string])[]
  /** Block comments nest (Swift, Rust, Kotlin, Dart) */
  nestedComments?: boolean
  /** Longest delimiters first */
  strings: readonly StringRule[]
  /** Letters that may start a string (`r"…"`, `f'…'`, `@"…"`, `b"…"`), skipped before matching a rule */
  stringPrefixes?: RegExp
  /** Characters allowed in identifiers besides letters, digits and `_` (`$` in JavaScript and PHP) */
  identifierChars?: string
  /** Rust raw strings `r#"…"#` */
  rawHashStrings?: boolean
}

export class LexError extends Error {
  readonly code: 'unterminatedString' | 'unterminatedComment'
  readonly index: number

  constructor(code: 'unterminatedString' | 'unterminatedComment', index: number) {
    super(code)
    this.code = code
    this.index = index
  }
}

// Punctuation read as one token: arrows, scopes, nullable markers, spreads
const MULTI_PUNCT = ['...', '?.', '??', '::', '->', '=>', '?:', '!!', '==', '!=', '<=', '>=', '&&', '||', '#[']

const C_STRINGS: StringRule[] = [
  { open: '"', close: '"', escapes: true, multiline: false },
  { open: "'", close: "'", escapes: true, multiline: false },
]

export const C_LIKE: LexerConfig = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: C_STRINGS,
}

function isIdentStart(char: string, extra: string): boolean {
  return /[\p{L}_]/u.test(char) || extra.includes(char)
}

function isIdentPart(char: string, extra: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char) || extra.includes(char)
}

function cleanDoc(raw: string): string {
  return raw
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(\/\*\*?|\*\/|\*|\/\/\/?|#+|""")\s?/, '')
        .replace(/\*\/\s*$/, '')
        .trim(),
    )
    .filter((line) => line !== '' && !line.startsWith('@'))
    .join(' ')
    .trim()
}

export function tokenize(text: string, config: LexerConfig): Token[] {
  const tokens: Token[] = []
  const extra = config.identifierChars ?? ''
  let index = 0
  let line = 1
  let lineStartIndex = 0
  let atLineStart = true
  let pendingDoc: { text: string; raw: string; endLine: number } | null = null

  function advanceTo(target: number) {
    for (; index < target; index++) {
      if (text[index] === '\n') {
        line++
        lineStartIndex = index + 1
        atLineStart = true
      }
    }
  }

  function push(kind: TokenKind, value: string, start: number, end: number) {
    const token: Token = { kind, value, start, end, line, column: start - lineStartIndex + 1, lineStart: atLineStart }
    // Documentation only counts when the comment ends on the line right before (or the same line)
    if (pendingDoc && pendingDoc.endLine >= line - 1) {
      if (pendingDoc.text) token.doc = pendingDoc.text
      token.docRaw = pendingDoc.raw
    }
    pendingDoc = null
    tokens.push(token)
    atLineStart = false
  }

  function readString(rule: StringRule, start: number, contentStart: number): void {
    let cursor = contentStart
    let value = ''
    for (;;) {
      if (cursor >= text.length) throw new LexError('unterminatedString', start)
      if (text.startsWith(rule.close, cursor)) break
      const char = text[cursor]
      if (char === '\n' && !rule.multiline) throw new LexError('unterminatedString', start)
      if (char === '\\' && rule.escapes && cursor + 1 < text.length) {
        const next = text[cursor + 1]
        value += next === 'n' ? '\n' : next === 't' ? '\t' : next
        cursor += 2
        continue
      }
      value += char
      cursor++
    }
    const end = cursor + rule.close.length
    push('string', value, start, end)
    advanceTo(end)
  }

  while (index < text.length) {
    const char = text[index]
    if (char === '\n' || char === ' ' || char === '\t' || char === '\r' || char === '\f' || char === '﻿') {
      advanceTo(index + 1)
      continue
    }

    const lineComment = config.lineComments.find((marker) => text.startsWith(marker, index))
    if (lineComment) {
      const end = text.indexOf('\n', index)
      const stop = end === -1 ? text.length : end
      const commentLine = line
      const raw = text.slice(index, stop)
      const content = cleanDoc(raw)
      pendingDoc =
        pendingDoc && pendingDoc.endLine === commentLine - 1
          ? { text: `${pendingDoc.text} ${content}`.trim(), raw: `${pendingDoc.raw}\n${raw}`, endLine: commentLine }
          : { text: content, raw, endLine: commentLine }
      advanceTo(stop)
      continue
    }

    const block = config.blockComments.find(([open]) => text.startsWith(open, index))
    if (block) {
      const [open, close] = block
      let depth = 1
      let cursor = index + open.length
      while (depth > 0) {
        if (cursor >= text.length) throw new LexError('unterminatedComment', index)
        if (config.nestedComments && text.startsWith(open, cursor)) {
          depth++
          cursor += open.length
        } else if (text.startsWith(close, cursor)) {
          depth--
          cursor += close.length
        } else cursor++
      }
      const raw = text.slice(index, cursor)
      advanceTo(cursor)
      pendingDoc = { text: cleanDoc(raw), raw, endLine: line }
      continue
    }

    // Rust raw strings: r"…", r#"…"#
    if (config.rawHashStrings && char === 'r' && /^r#*"/.test(text.slice(index, index + 10))) {
      const hashes = /^r(#*)"/.exec(text.slice(index))![1]
      readString({ open: `r${hashes}"`, close: `"${hashes}`, escapes: false, multiline: true }, index, index + hashes.length + 2)
      continue
    }

    // String prefixes (r, b, f, @, $): only when a quote follows right away
    let prefixLength = 0
    if (config.stringPrefixes) {
      const match = config.stringPrefixes.exec(text.slice(index, index + 4))
      if (match && match.index === 0 && config.strings.some((rule) => text.startsWith(rule.open, index + match[0].length))) {
        prefixLength = match[0].length
      }
    }
    const rule = config.strings.find((item) => text.startsWith(item.open, index + prefixLength))
    if (rule) {
      // A verbatim C# string (@"…") or raw Python string (r"…") has no escapes
      const raw = /[@rR]/.test(text.slice(index, index + prefixLength))
      readString(raw ? { ...rule, escapes: false } : rule, index, index + prefixLength + rule.open.length)
      continue
    }

    if (isIdentStart(char, extra)) {
      let end = index + 1
      while (end < text.length && isIdentPart(text[end], extra)) end++
      push('ident', text.slice(index, end), index, end)
      advanceTo(end)
      continue
    }

    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(text[index + 1] ?? ''))) {
      const match = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?|\.[0-9]+([eE][+-]?[0-9]+)?)[a-zA-Z]*/.exec(
        text.slice(index),
      )!
      const end = index + match[0].length
      push('number', match[0], index, end)
      advanceTo(end)
      continue
    }

    const multi = MULTI_PUNCT.find((item) => text.startsWith(item, index))
    const value = multi ?? char
    push('punct', value, index, index + value.length)
    advanceTo(index + value.length)
  }
  return tokens
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** Reading position over the tokens, with the helpers every declaration parser needs. */
export class Cursor {
  readonly tokens: Token[]
  index = 0

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  get done(): boolean {
    return this.index >= this.tokens.length
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset]
  }

  /** The value of a token ahead, or '' at the end: comparisons need no undefined checks */
  value(offset = 0): string {
    return this.tokens[this.index + offset]?.value ?? ''
  }

  is(value: string, offset = 0): boolean {
    const token = this.tokens[this.index + offset]
    return token !== undefined && token.kind !== 'string' && token.value === value
  }

  isIdent(offset = 0): boolean {
    return this.tokens[this.index + offset]?.kind === 'ident'
  }

  next(): Token {
    const token = this.tokens[this.index]
    this.index++
    return token
  }

  eat(value: string): boolean {
    if (this.is(value)) {
      this.index++
      return true
    }
    return false
  }

  /** Skips a balanced group starting at the current `(`, `[` or `{` (all bracket kinds are tracked). */
  skipGroup(): void {
    const open = this.value()
    if (!(open in OPEN)) {
      this.index++
      return
    }
    const stack: string[] = []
    while (!this.done) {
      const token = this.next()
      if (token.kind !== 'punct') continue
      if (token.value in OPEN) stack.push(OPEN[token.value])
      else if (token.value === stack.at(-1)) {
        stack.pop()
        if (stack.length === 0) return
      }
    }
  }

  /** Text of the source between two token indexes, for raw annotation arguments and default values. */
  textBetween(source: string, from: number, to: number): string {
    if (from >= to) return ''
    return source.slice(this.tokens[from].start, this.tokens[to - 1].end)
  }

  /** Skips to just after the next token with one of these values at the current nesting level. */
  skipUntil(values: readonly string[], stopAtClose = true): void {
    let depth = 0
    while (!this.done) {
      const token = this.peek()!
      if (token.kind === 'punct') {
        if (depth === 0 && values.includes(token.value)) return
        if (token.value in OPEN) depth++
        else if (token.value === ')' || token.value === ']' || token.value === '}') {
          if (depth === 0 && stopAtClose) return
          depth--
        }
      }
      this.index++
    }
  }
}
