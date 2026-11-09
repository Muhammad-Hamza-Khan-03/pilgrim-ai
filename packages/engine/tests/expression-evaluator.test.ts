import { describe, expect, it } from 'vitest';
import { evaluateExpression, ExpressionEvaluationError } from '../src/expression-evaluator.js';

const options = { maxSourceLength: 500, maxAstNodes: 100, maxDepth: 20, maxIterations: 100 };

describe('sandboxed expression evaluator', () => {
  it('evaluates finite arithmetic with unary operators and precedence', () => {
    expect(evaluateExpression('-(2 + 3) * +4 / 2', {}, options)).toBe(-10);
    expect(evaluateExpression('2 + 3 * 4', {}, options)).toBe(14);
  });

  it('evaluates typed comparisons and rejects non-finite numeric results', () => {
    expect(evaluateExpression('price >= 10 && nights < 5', { price: 12, nights: 3 }, options)).toBe(true);
    expect(() => evaluateExpression('1 / 0', {}, options)).toThrow(ExpressionEvaluationError);
    expect(() => evaluateExpression('1 / 0 + 1', {}, options)).toThrow(ExpressionEvaluationError);
  });

  it('resolves dotted and bracket references without prototype traversal', () => {
    const context = { trip: { nights: 7 }, legs: [{ rate: { price: 12 } }] };
    expect(evaluateExpression('trip.nights + legs[0].rate.price', context, options)).toBe(19);
    expect(() => evaluateExpression('constructor.name', {}, options)).toThrow(ExpressionEvaluationError);
    expect(() => evaluateExpression('trip["__proto__"]', context, options)).toThrow(ExpressionEvaluationError);
  });

  it('compares dates only as typed ISO calendar dates', () => {
    expect(evaluateExpression('start < end', { start: '2026-01-02', end: '2026-01-03' }, options)).toBe(true);
    expect(evaluateExpression('start == same', { start: '2026-01-02', same: '2026-01-02' }, options)).toBe(true);
    expect(() => evaluateExpression('start < end', { start: 'not-a-date', end: '2026-01-03' }, options)).toThrow(ExpressionEvaluationError);
    expect(() => evaluateExpression('start < end', { start: '2026-02-31', end: '2026-03-03' }, options)).toThrow(ExpressionEvaluationError);
  });

  it.each([
    ['0000-01-01', '0000-01-02'],
    ['0001-01-01', '0001-01-02'],
    ['0099-12-30', '0100-01-01'],
  ])('supports ISO dates with year %s without legacy Date.UTC behavior', (start, end) => {
    expect(evaluateExpression('start < end', { start, end }, options)).toBe(true);
  });

  it('rejects invalid dates in the early ISO year range', () => {
    expect(() => evaluateExpression('start < end', { start: '0000-02-30', end: '0001-01-01' }, options)).toThrow(ExpressionEvaluationError);
  });

  it('fails closed when an aggregate result becomes non-finite', () => {
    expect(() => evaluateExpression('sum(values)', { values: [Number.MAX_VALUE, Number.MAX_VALUE] }, options)).toThrow(ExpressionEvaluationError);
    expect(() => evaluateExpression('sum(values, value * 2)', { values: [Number.MAX_VALUE] }, options)).toThrow(ExpressionEvaluationError);
  });

  it('rejects non-finite and negative effective limits before parsing or evaluation', () => {
    for (const limit of ['maxSourceLength', 'maxAstNodes', 'maxDepth', 'maxIterations'] as const) {
      expect(() => evaluateExpression('1', {}, { [limit]: Number.NaN })).toThrow(ExpressionEvaluationError);
      expect(() => evaluateExpression('1', {}, { [limit]: -1 })).toThrow(ExpressionEvaluationError);
      expect(() => evaluateExpression('1', {}, { [limit]: Number.POSITIVE_INFINITY })).toThrow(ExpressionEvaluationError);
    }
  });

  it('bounds parser recursion before deeply nested parentheses can overflow the call stack', () => {
    const source = `${'('.repeat(5000)}1${')'.repeat(5000)}`;
    expect(() => evaluateExpression(source, {}, { ...options, maxSourceLength: 20_000, maxAstNodes: 10_000, maxDepth: 10 })).toThrow(ExpressionEvaluationError);
  });

  it('supports allowlisted aggregates including nested aggregate syntax', () => {
    const context = {
      legs: [
        { allocation: [{ nights: [{ rate: { price: 10 } }, { rate: { price: 12 } }] }] },
        { allocation: [{ nights: [{ rate: { price: 8 } }] }] },
      ],
    };
    expect(evaluateExpression('sum(legs, sum(allocation, sum(nights, rate.price)))', context, options)).toBe(30);
    expect(evaluateExpression('min(values)', { values: [4, 2, 7] }, options)).toBe(2);
    expect(evaluateExpression('max(values)', { values: [4, 2, 7] }, options)).toBe(7);
  });

  it('fails closed for unsupported syntax, missing values, and invalid aggregate inputs', () => {
    for (const expression of ['foo()', 'a ? b : c', 'missing + 1', 'sum(3)', 'min(values, value, value)']) {
      expect(() => evaluateExpression(expression, { values: [1, 2] }, options)).toThrow(ExpressionEvaluationError);
    }
  });

  it('does not mutate context while evaluating', () => {
    const context = { values: [1, 2], nested: { value: 3 } };
    const before = structuredClone(context);
    expect(evaluateExpression('sum(values) + nested.value', context, options)).toBe(6);
    expect(context).toEqual(before);
  });

  it('enforces source, AST, depth, and iteration limits explicitly', () => {
    expect(() => evaluateExpression('1 + 1', {}, { ...options, maxSourceLength: 2 })).toThrow(/source length/i);
    expect(() => evaluateExpression('1 + 1 + 1', {}, { ...options, maxAstNodes: 2 })).toThrow(/AST/i);
    expect(() => evaluateExpression('sum(values)', { values: [1, 2, 3] }, { ...options, maxIterations: 2 })).toThrow(/iteration/i);
    expect(() => evaluateExpression('sum(values, sum(values, value))', { values: [1] }, { ...options, maxDepth: 1 })).toThrow(/depth/i);
  });

  it('rejects code generation and dynamic execution constructs', () => {
    for (const expression of ['eval("1+1")', 'Function("return 1")()', 'globalThis.process']) {
      expect(() => evaluateExpression(expression, {}, options)).toThrow(ExpressionEvaluationError);
    }
  });
});
