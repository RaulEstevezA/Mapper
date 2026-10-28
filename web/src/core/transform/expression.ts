/** Mapper's expression language for custom transformations. It is deliberately small: literals,
 * source fields, arithmetic, comparisons, `??`, a conditional and a closed list of functions. It is
 * parsed into a tree and checked here, then translated by each generator; it is never evaluated in the
 * browser, so no user text is ever run (docs/transformations.md). */

export type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'any'

export type Expr =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'field'; path: string[] }
  | { kind: 'unary'; operator: '-' | '!'; operand: Expr }
  | { kind: 'binary'; operator: BinaryOperator; left: Expr; right: Expr }
  | { kind: 'conditional'; condition: Expr; then: Expr; otherwise: Expr }
  | { kind: 'call'; name: FunctionName; args: Expr[] }

export type BinaryOperator = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||' | '??'

export type FunctionName = keyof typeof FUNCTIONS

/** Every function the language has: argument kinds (the last one may repeat) and result kind. */
export const FUNCTIONS = {
  upper: { args: ['string'], result: 'string' },
  lower: { args: ['string'], result: 'string' },
  trim: { args: ['string'], result: 'string' },
  length: { args: ['string'], result: 'number' },
  concat: { args: ['any', 'any'], result: 'string', variadic: true },
  substring: { args: ['string', 'number', 'number'], result: 'string', optional: 1 },
  replace: { args: ['string', 'string', 'string'], result: 'string' },
  round: { args: ['number'], result: 'number' },
  floor: { args: ['number'], result: 'number' },
  ceil: { args: ['number'], result: 'number' },
  abs: { args: ['number'], result: 'number' },
  min: { args: ['number', 'number'], result: 'number' },
  max: { args: ['number', 'number'], result: 'number' },
  toString: { args: ['any'], result: 'string' },
  toNumber: { args: ['string'], result: 'number' },
} as const satisfies Record<string, { args: readonly ValueKind[]; result: ValueKind; variadic?: boolean; optional?: number }>

export type ExpressionErrorCode =
  'empty' | 'unexpectedToken' | 'unterminatedString' | 'unknownFunction' | 'argumentCount' | 'unknownField' | 'typeMismatch' | 'tooComplex'

export interface ExpressionError {
  code: ExpressionErrorCode
  /** 1-based column in the expression */
  column: number
  params?: Record<string, string | number>
}

interface Token {
  type: 'number' | 'string' | 'name' | 'operator' | 'end'
  text: string
  value?: string | number
  column: number
}

const OPERATORS = ['??', '==', '!=', '<=', '>=', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '!', '(', ')', ',', '.', '?', ':']
// Limits that keep generated code readable and the parser safe from pathological input
const MAX_LENGTH = 2000
const MAX_DEPTH = 40

class ParseError extends Error {
  readonly error: ExpressionError

  constructor(error: ExpressionError) {
    super(error.code)
    this.error = error
  }
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (/\s/.test(char)) {
      index++
      continue
    }
    const column = index + 1
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(text[index + 1] ?? ''))) {
      const match = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(text.slice(index))!
      tokens.push({ type: 'number', text: match[0], value: Number(match[0]), column })
      index += match[0].length
      continue
    }
    if (char === '"' || char === "'") {
      let value = ''
      let cursor = index + 1
      for (;;) {
        if (cursor >= text.length) throw new ParseError({ code: 'unterminatedString', column })
        const current = text[cursor]
        if (current === char) break
        if (current === '\\' && cursor + 1 < text.length) {
          const next = text[cursor + 1]
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next
          cursor += 2
          continue
        }
        value += current
        cursor++
      }
      tokens.push({ type: 'string', text: text.slice(index, cursor + 1), value, column })
      index = cursor + 1
      continue
    }
    if (/[\p{L}_$]/u.test(char)) {
      const match = /^[\p{L}\p{N}_$]+/u.exec(text.slice(index))!
      tokens.push({ type: 'name', text: match[0], column })
      index += match[0].length
      continue
    }
    const operator = OPERATORS.find((item) => text.startsWith(item, index))
    if (!operator) throw new ParseError({ code: 'unexpectedToken', column, params: { found: char } })
    tokens.push({ type: 'operator', text: operator, column })
    index += operator.length
  }
  tokens.push({ type: 'end', text: '', column: text.length + 1 })
  return tokens
}

// Binding power of binary operators: higher binds tighter
const PRECEDENCE: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
}

class Parser {
  private readonly tokens: Token[]
  private index = 0
  private depth = 0

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  private peek(): Token {
    return this.tokens[this.index]
  }

  private next(): Token {
    return this.tokens[this.index++]
  }

  private expect(text: string) {
    const token = this.next()
    if (token.text !== text || token.type === 'string')
      throw new ParseError({ code: 'unexpectedToken', column: token.column, params: { found: token.text || 'end', expected: text } })
  }

  parse(): Expr {
    const expr = this.expression()
    const token = this.peek()
    if (token.type !== 'end') throw new ParseError({ code: 'unexpectedToken', column: token.column, params: { found: token.text } })
    return expr
  }

  private expression(): Expr {
    if (++this.depth > MAX_DEPTH) throw new ParseError({ code: 'tooComplex', column: this.peek().column })
    const condition = this.binary(1)
    let result = condition
    if (this.peek().type === 'operator' && this.peek().text === '?') {
      this.next()
      const then = this.expression()
      this.expect(':')
      const otherwise = this.expression()
      result = { kind: 'conditional', condition, then, otherwise }
    }
    this.depth--
    return result
  }

  private binary(minimum: number): Expr {
    let left = this.unary()
    for (;;) {
      const token = this.peek()
      const precedence = token.type === 'operator' ? PRECEDENCE[token.text] : undefined
      if (precedence === undefined || precedence < minimum) return left
      this.next()
      const right = this.binary(precedence + 1)
      left = { kind: 'binary', operator: token.text as BinaryOperator, left, right }
    }
  }

  private unary(): Expr {
    const token = this.peek()
    if (token.type === 'operator' && (token.text === '-' || token.text === '!')) {
      this.next()
      if (++this.depth > MAX_DEPTH) throw new ParseError({ code: 'tooComplex', column: token.column })
      const operand = this.unary()
      this.depth--
      // `-5` is a literal, so generated code reads naturally
      if (token.text === '-' && operand.kind === 'literal' && typeof operand.value === 'number')
        return { kind: 'literal', value: -operand.value }
      return { kind: 'unary', operator: token.text, operand }
    }
    return this.primary()
  }

  private primary(): Expr {
    const token = this.next()
    if (token.type === 'number' || token.type === 'string') return { kind: 'literal', value: token.value! }
    if (token.type === 'operator' && token.text === '(') {
      const inner = this.expression()
      this.expect(')')
      return inner
    }
    if (token.type === 'name') {
      if (token.text === 'true' || token.text === 'false') return { kind: 'literal', value: token.text === 'true' }
      if (token.text === 'null') return { kind: 'literal', value: null }
      if (this.peek().text === '(' && this.peek().type === 'operator') {
        if (!(token.text in FUNCTIONS))
          throw new ParseError({ code: 'unknownFunction', column: token.column, params: { name: token.text } })
        this.next()
        const args: Expr[] = []
        if (this.peek().text !== ')') {
          do args.push(this.expression())
          while (this.peek().type === 'operator' && this.peek().text === ',' && this.next())
        }
        this.expect(')')
        const definition = FUNCTIONS[token.text as FunctionName] as { args: readonly ValueKind[]; variadic?: boolean; optional?: number }
        const min = definition.args.length - (definition.optional ?? 0)
        const max = definition.variadic ? Infinity : definition.args.length
        if (args.length < min || args.length > max)
          throw new ParseError({ code: 'argumentCount', column: token.column, params: { name: token.text, count: min } })
        return { kind: 'call', name: token.text as FunctionName, args }
      }
      // `source.address.city` and `address.city` name the same field
      const path = token.text === 'source' && this.peek().text === '.' ? [] : [token.text]
      while (this.peek().type === 'operator' && this.peek().text === '.') {
        this.next()
        const part = this.next()
        if (part.type !== 'name')
          throw new ParseError({ code: 'unexpectedToken', column: part.column, params: { found: part.text || 'end' } })
        path.push(part.text)
      }
      return { kind: 'field', path }
    }
    throw new ParseError({ code: 'unexpectedToken', column: token.column, params: { found: token.text || 'end' } })
  }
}

export type ParsedExpression = { ok: true; expr: Expr; fields: string[][] } | { ok: false; error: ExpressionError }

/** Fields an expression reads, without repetitions, in order of appearance. */
export function expressionFields(expr: Expr): string[][] {
  const fields: string[][] = []
  const visit = (node: Expr) => {
    switch (node.kind) {
      case 'field':
        if (!fields.some((path) => path.join('.') === node.path.join('.'))) fields.push(node.path)
        break
      case 'unary':
        visit(node.operand)
        break
      case 'binary':
        visit(node.left)
        visit(node.right)
        break
      case 'conditional':
        visit(node.condition)
        visit(node.then)
        visit(node.otherwise)
        break
      case 'call':
        node.args.forEach(visit)
        break
      case 'literal':
        break
    }
  }
  visit(expr)
  return fields
}

export function parseExpression(text: string): ParsedExpression {
  if (text.trim() === '') return { ok: false, error: { code: 'empty', column: 1 } }
  if (text.length > MAX_LENGTH) return { ok: false, error: { code: 'tooComplex', column: MAX_LENGTH } }
  try {
    const expr = new Parser(tokenize(text)).parse()
    return { ok: true, expr, fields: expressionFields(expr) }
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: error.error }
    throw error
  }
}

/** Kind of the value of an expression, given the kind of each field. Reports the first type error. */
export function checkExpression(
  expr: Expr,
  fieldKind: (path: string[]) => ValueKind | null,
): { kind: ValueKind } | { error: ExpressionError } {
  const fail = (code: ExpressionErrorCode, params?: Record<string, string | number>): never => {
    throw new ParseError({ code, column: 1, ...(params ? { params } : {}) })
  }
  const compatible = (actual: ValueKind, expected: ValueKind) =>
    expected === 'any' || actual === 'any' || actual === expected || actual === 'null'
  const kindOf = (node: Expr): ValueKind => {
    switch (node.kind) {
      case 'literal':
        return node.value === null ? 'null' : (typeof node.value as ValueKind)
      case 'field': {
        const kind = fieldKind(node.path)
        if (kind === null) fail('unknownField', { field: node.path.join('.') })
        return kind!
      }
      case 'unary': {
        const operand = kindOf(node.operand)
        const expected = node.operator === '-' ? 'number' : 'boolean'
        if (!compatible(operand, expected)) fail('typeMismatch', { operator: node.operator, expected, found: operand })
        return expected
      }
      case 'binary': {
        const left = kindOf(node.left)
        const right = kindOf(node.right)
        if (node.operator === '??') return left === 'null' ? right : left
        if (node.operator === '&&' || node.operator === '||') {
          for (const side of [left, right])
            if (!compatible(side, 'boolean')) fail('typeMismatch', { operator: node.operator, expected: 'boolean', found: side })
          return 'boolean'
        }
        if (node.operator === '==' || node.operator === '!=') return 'boolean'
        if (node.operator === '+' && (left === 'string' || right === 'string')) {
          // Joining text: both sides must be text, use concat() to join other values
          for (const side of [left, right])
            if (!compatible(side, 'string')) fail('typeMismatch', { operator: '+', expected: 'string', found: side })
          return 'string'
        }
        for (const side of [left, right])
          if (!compatible(side, 'number')) fail('typeMismatch', { operator: node.operator, expected: 'number', found: side })
        return ['<', '<=', '>', '>='].includes(node.operator) ? 'boolean' : 'number'
      }
      case 'conditional': {
        const condition = kindOf(node.condition)
        if (!compatible(condition, 'boolean')) fail('typeMismatch', { operator: '?', expected: 'boolean', found: condition })
        const then = kindOf(node.then)
        const otherwise = kindOf(node.otherwise)
        return then === otherwise ? then : then === 'null' ? otherwise : otherwise === 'null' ? then : 'any'
      }
      case 'call': {
        const definition = FUNCTIONS[node.name] as { args: readonly ValueKind[]; result: ValueKind; variadic?: boolean }
        node.args.forEach((arg, index) => {
          const expected = definition.args[Math.min(index, definition.args.length - 1)]
          const actual = kindOf(arg)
          if (!compatible(actual, expected)) fail('typeMismatch', { operator: node.name, expected, found: actual })
        })
        return definition.result
      }
    }
  }
  try {
    return { kind: kindOf(expr) }
  } catch (error) {
    if (error instanceof ParseError) return { error: error.error }
    throw error
  }
}
