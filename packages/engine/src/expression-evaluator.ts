export interface ExpressionLimits {
  maxSourceLength?: number;
  maxAstNodes?: number;
  maxDepth?: number;
  maxIterations?: number;
}

export class ExpressionEvaluationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'EXPRESSION_INVALID') {
    super(message);
    this.name = 'ExpressionEvaluationError';
    this.code = code;
  }
}

type Value = number | boolean | string | null | Value[] | { [key: string]: unknown };
type Context = Record<string, unknown>;
type Node =
  | { kind: 'literal'; value: Value }
  | { kind: 'reference'; parts: string[] }
  | { kind: 'unary'; op: '+' | '-'; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: 'sum' | 'min' | 'max'; args: Node[] };

type Token = { kind: 'number' | 'string' | 'identifier' | 'operator' | 'punctuation' | 'eof'; value: string; position: number };

const DEFAULT_LIMITS: Required<ExpressionLimits> = {
  maxSourceLength: 4096,
  maxAstNodes: 512,
  maxDepth: 64,
  maxIterations: 10_000,
};
const FORBIDDEN_PARTS = new Set(['__proto__', 'prototype', 'constructor']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message: string, code = 'EXPRESSION_INVALID'): never {
  throw new ExpressionEvaluationError(message, code);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    const position = i;
    const char = source[i];
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) fail(`Invalid number at ${i}`);
      tokens.push({ kind: 'number', value: match[0], position }); i += match[0].length; continue;
    }
    if (char === '"' || char === "'") {
      const quote = char; i++;
      let value = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          const escaped = source[i + 1];
          if (!escaped || !'\\"\'nrt'.includes(escaped)) fail(`Invalid string escape at ${i}`);
          value += escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped;
          i += 2;
        } else { value += source[i++]; }
      }
      if (source[i] !== quote) fail(`Unterminated string at ${position}`);
      i++; tokens.push({ kind: 'string', value, position }); continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const match = source.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)!;
      tokens.push({ kind: 'identifier', value: match[0], position }); i += match[0].length; continue;
    }
    const operator = source.slice(i).match(/^(===|!==|==|!=|<=|>=|&&|\|\||[+\-*/%<>=!])/);
    if (operator) { tokens.push({ kind: 'operator', value: operator[0], position }); i += operator[0].length; continue; }
    if ('().[],'.includes(char)) { tokens.push({ kind: 'punctuation', value: char, position }); i++; continue; }
    fail(`Unsupported character '${char}' at ${i}`);
  }
  tokens.push({ kind: 'eof', value: '', position: source.length });
  return tokens;
}

class Parser {
  private index = 0;
  private nodes = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[], private readonly limit: number, private readonly maxDepth: number) {}
  parse(): Node {
    const node = this.parseOr();
    if (this.peek().kind !== 'eof') fail(`Unexpected token '${this.peek().value}'`);
    return node;
  }
  private count(): void { if (++this.nodes > this.limit) fail('AST node limit exceeded', 'AST_LIMIT'); }
  private peek(): Token { return this.tokens[this.index]; }
  private take(value?: string): Token { const token = this.peek(); if (value !== undefined && token.value !== value) fail(`Expected '${value}' at ${token.position}`); this.index++; return token; }
  private match(value: string): boolean { if (this.peek().value === value) { this.index++; return true; } return false; }
  private binary(next: () => Node, operators: Set<string>): Node {
    let left = next();
    while (operators.has(this.peek().value)) { const op = this.take().value; const right = next(); this.count(); left = { kind: 'binary', op, left, right }; }
    return left;
  }
  private parseOr(): Node { return this.binary(() => this.parseAnd(), new Set(['||'])); }
  private parseAnd(): Node { return this.binary(() => this.parseCompare(), new Set(['&&'])); }
  private parseCompare(): Node { return this.binary(() => this.parseAdd(), new Set(['==', '===', '!=', '!==', '<', '<=', '>', '>='])); }
  private parseAdd(): Node { return this.binary(() => this.parseMultiply(), new Set(['+', '-'])); }
  private parseMultiply(): Node { return this.binary(() => this.parseUnary(), new Set(['*', '/', '%'])); }
  private parseUnary(): Node {
    if (this.match('+') || this.match('-')) {
      if (++this.depth > this.maxDepth) fail('Expression depth limit exceeded', 'DEPTH_LIMIT');
      try { const op = this.tokens[this.index - 1].value as '+' | '-'; const operand = this.parseUnary(); this.count(); return { kind: 'unary', op, operand }; } finally { this.depth--; }
    }
    return this.parsePrimary();
  }
  private parsePrimary(): Node {
    const token = this.peek();
    if (token.kind === 'number') { this.take(); this.count(); return { kind: 'literal', value: Number(token.value) }; }
    if (token.kind === 'string') { this.take(); this.count(); return { kind: 'literal', value: token.value }; }
    if (token.kind === 'identifier') {
      this.take();
      if (token.value === 'true' || token.value === 'false' || token.value === 'null') { this.count(); return { kind: 'literal', value: token.value === 'true' ? true : token.value === 'false' ? false : null }; }
      if (this.match('(')) {
        if (!['sum', 'min', 'max'].includes(token.value)) fail(`Function '${token.value}' is not allowed`);
        if (++this.depth > this.maxDepth) fail('Expression depth limit exceeded', 'DEPTH_LIMIT');
        try {
          const args: Node[] = [];
          if (!this.match(')')) { do { args.push(this.parseOr()); } while (this.match(',')); this.take(')'); }
          this.count(); return { kind: 'call', name: token.value as 'sum' | 'min' | 'max', args };
        } finally { this.depth--; }
      }
      const parts = [token.value];
      while (true) {
        if (this.match('.')) { const part = this.take(); if (part.kind !== 'identifier') fail(`Expected property name at ${part.position}`); parts.push(part.value); continue; }
        if (this.match('[')) { const part = this.take(); if (part.kind !== 'string' && part.kind !== 'number' && part.kind !== 'identifier') fail('Invalid bracket property'); parts.push(part.value); this.take(']'); continue; }
        break;
      }
      if (parts.some((part) => FORBIDDEN_PARTS.has(part))) fail('Prototype paths are not allowed', 'PROTOTYPE_PATH');
      this.count(); return { kind: 'reference', parts };
    }
    if (this.match('(')) {
      if (++this.depth > this.maxDepth) fail('Expression depth limit exceeded', 'DEPTH_LIMIT');
      try { const node = this.parseOr(); this.take(')'); return node; } finally { this.depth--; }
    }
    fail(`Unexpected token '${token.value}' at ${token.position}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(0, 0, 0, 0);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
function resolve(parts: string[], scopes: Record<string, unknown>[]): unknown {
  let value: unknown;
  const first = parts[0];
  for (const scope of scopes) if (Object.prototype.hasOwnProperty.call(scope, first)) { value = scope[first]; break; }
  if (value === undefined) fail(`Missing reference '${parts.join('.')}'`, 'MISSING_REFERENCE');
  for (const part of parts.slice(1)) {
    if (FORBIDDEN_PARTS.has(part)) fail('Prototype paths are not allowed', 'PROTOTYPE_PATH');
    if (Array.isArray(value) && /^\d+$/.test(part)) value = value[Number(part)];
    else if (isObject(value) && Object.prototype.hasOwnProperty.call(value, part)) value = value[part];
    else fail(`Missing reference '${parts.join('.')}'`, 'MISSING_REFERENCE');
  }
  return value;
}

function finiteNumber(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) fail('Expected a finite number', 'TYPE_ERROR'); return value; }
function compare(left: unknown, right: unknown, op: string): boolean {
  if (typeof left === 'number' && typeof right === 'number') { if (!Number.isFinite(left) || !Number.isFinite(right)) fail('Expected finite numbers', 'TYPE_ERROR'); }
  else if (isDate(left) && isDate(right)) { /* Fixed-width ISO dates sort chronologically as strings. */ }
  else if (op !== '==' && op !== '===' && op !== '!=' && op !== '!==') fail('Comparison requires matching numbers or dates', 'TYPE_ERROR');
  switch (op) { case '==': case '===': return left === right; case '!=': case '!==': return left !== right; case '<': return (left as any) < (right as any); case '<=': return (left as any) <= (right as any); case '>': return (left as any) > (right as any); case '>=': return (left as any) >= (right as any); default: fail(`Unsupported operator '${op}'`); }
}

function evaluate(node: Node, scopes: Record<string, unknown>[], limits: Required<ExpressionLimits>, depth: number, state: { iterations: number }): Value {
  if (depth > limits.maxDepth) fail('Expression depth limit exceeded', 'DEPTH_LIMIT');
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'reference') return resolve(node.parts, scopes) as Value;
  if (node.kind === 'unary') { const value = finiteNumber(evaluate(node.operand, scopes, limits, depth + 1, state)); return node.op === '-' ? -value : value; }
  if (node.kind === 'binary') {
    if (node.op === '&&') return Boolean(evaluate(node.left, scopes, limits, depth + 1, state)) && Boolean(evaluate(node.right, scopes, limits, depth + 1, state));
    if (node.op === '||') return Boolean(evaluate(node.left, scopes, limits, depth + 1, state)) || Boolean(evaluate(node.right, scopes, limits, depth + 1, state));
    const left = evaluate(node.left, scopes, limits, depth + 1, state); const right = evaluate(node.right, scopes, limits, depth + 1, state);
    if (['==', '===', '!=', '!==', '<', '<=', '>', '>='].includes(node.op)) return compare(left, right, node.op);
    const a = finiteNumber(left); const b = finiteNumber(right); let result: number;
    if (node.op === '+') result = a + b; else if (node.op === '-') result = a - b; else if (node.op === '*') result = a * b; else if (node.op === '/') { if (b === 0) fail('Division by zero', 'NON_FINITE'); result = a / b; } else { if (b === 0) fail('Division by zero', 'NON_FINITE'); result = a % b; }
    if (!Number.isFinite(result)) fail('Arithmetic result is not finite', 'NON_FINITE'); return result;
  }
  const values = evaluate(node.args[0], scopes, limits, depth + 1, state);
  if (!Array.isArray(values)) fail(`${node.name} requires an array`, 'TYPE_ERROR');
  if (node.args.length === 1) {
    const numbers = values.map((value) => { state.iterations++; if (state.iterations > limits.maxIterations) fail('Iteration limit exceeded', 'ITERATION_LIMIT'); return finiteNumber(value); });
    if (node.name === 'sum') return numbers.reduce((total, value) => finiteNumber(total + value), 0);
    if (numbers.length === 0) fail(`${node.name} cannot reduce an empty array`, 'ARGUMENT_ERROR');
    return node.name === 'min' ? Math.min(...numbers) : Math.max(...numbers);
  }
  if (node.args.length !== 2) fail(`${node.name} expects one or two arguments`, 'ARGUMENT_ERROR');
  if (node.name === 'sum') return values.reduce<number>((total, item) => { state.iterations++; if (state.iterations > limits.maxIterations) fail('Iteration limit exceeded', 'ITERATION_LIMIT'); return finiteNumber(total + finiteNumber(evaluate(node.args[1], [{ value: item, ...(isObject(item) ? item : {}) }, ...scopes], limits, depth + 1, state))); }, 0);
  const evaluated = values.map((item) => { state.iterations++; if (state.iterations > limits.maxIterations) fail('Iteration limit exceeded', 'ITERATION_LIMIT'); return finiteNumber(evaluate(node.args[1], [{ value: item, ...(isObject(item) ? item : {}) }, ...scopes], limits, depth + 1, state)); });
  if (evaluated.length === 0) fail(`${node.name} cannot reduce an empty array`, 'ARGUMENT_ERROR');
  return node.name === 'min' ? Math.min(...evaluated) : Math.max(...evaluated);
}

export function evaluateExpression(source: string, context: Context, limits: ExpressionLimits = {}): Value {
  const effective = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(effective)) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) fail(`Invalid ${name} limit`, 'LIMIT_INVALID');
  }
  if (source.length > effective.maxSourceLength) fail('Source length limit exceeded', 'SOURCE_LIMIT');
  if (!isObject(context)) fail('Context must be an object', 'TYPE_ERROR');
  const ast = new Parser(tokenize(source), effective.maxAstNodes, effective.maxDepth).parse();
  return evaluate(ast, [context], effective, 0, { iterations: 0 });
}
