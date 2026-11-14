import { describe, expect, it } from 'vitest';
import { KnowledgeRetrievalError } from '../src/in-memory-knowledge-retrieval.js';
import { createKnowledgeRetrievalContextGate } from '../src/knowledge-retrieval-context-gate.js';
import type { KnowledgeRetrievalContextItem, KnowledgeRetrievalContextResult } from '../src/knowledge-retrieval-context.js';

const item = (recordId: string, score: number): KnowledgeRetrievalContextItem => ({
  recordId, score, text: 'text', citation: { datasetVersion: 3, sourceId: 's', chunkId: `c-${recordId}`, blockId: 'b', startLine: 1, endLine: 2 },
});
const avail = (...items: KnowledgeRetrievalContextItem[]): KnowledgeRetrievalContextResult => ({ status: 'available', datasetVersion: 3, items, totalCharacters: items.length * 4 });
const run = (context: unknown, minScore = 1, datasetVersion = 3) =>
  createKnowledgeRetrievalContextGate().evaluate({ datasetVersion, context: context as KnowledgeRetrievalContextResult, minScore });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof KnowledgeRetrievalError ? e.code : 'other'; } return 'none'; };

describe('knowledge retrieval context gate', () => {
  it('is ready at an inclusive threshold, using first item as topScore without reordering', () => {
    const ctx = avail(item('a', 1), item('b', 9));
    const r = run(ctx, 1);
    expect(r).toEqual({ status: 'ready', datasetVersion: 3, items: ctx.items, totalCharacters: 8, topScore: 1 });
  });

  it('is insufficient below threshold and for no items', () => {
    expect(run(avail(item('a', 0.5)), 1)).toEqual({ status: 'insufficient', reason: 'below-threshold', datasetVersion: 3, items: [], totalCharacters: 0, topScore: 0.5 });
    expect(run(avail(), 1)).toEqual({ status: 'insufficient', reason: 'no-items', datasetVersion: 3, items: [], totalCharacters: 0 });
  });

  it('preserves unavailable', () => {
    expect(run({ status: 'unavailable', reason: 'index-unavailable', items: [], totalCharacters: 0 })).toEqual({ status: 'unavailable', reason: 'index-unavailable', datasetVersion: 3, items: [], totalCharacters: 0 });
  });

  it('deep-clones and deep-freezes without mutating input', () => {
    const ctx = avail(item('a', 2));
    const r = run(ctx);
    if (r.status !== 'ready') throw new Error();
    expect(r.items[0]).not.toBe(ctx.items[0]);
    expect(Object.isFrozen(r) && Object.isFrozen(r.items) && Object.isFrozen(r.items[0]) && Object.isFrozen(r.items[0]!.citation)).toBe(true);
    expect(Object.isFrozen(ctx.items[0])).toBe(false);
    expect(run(avail(), 1)).toSatisfy(Object.isFrozen);
  });

  it('rejects invalid requests and malformed contexts with typed errors', () => {
    for (const v of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(code(() => run(avail(), 1, v))).toBe('INVALID_REQUEST');
    for (const m of [NaN, Infinity, '1']) expect(code(() => run(avail(), m as number))).toBe('INVALID_REQUEST');
    expect(code(() => run(null))).toBe('INVALID_RECORD');
    expect(code(() => run({ status: 'available', datasetVersion: 4, items: [], totalCharacters: 0 }))).toBe('INVALID_RECORD');
    expect(code(() => run({ status: 'other', items: [] }))).toBe('INVALID_RECORD');
    expect(code(() => run({ status: 'available', datasetVersion: 3, items: [], totalCharacters: 1 }))).toBe('INVALID_RECORD');
    expect(code(() => run({ status: 'unavailable', reason: 'index-unavailable', items: [item('a', 1)], totalCharacters: 0 }))).toBe('INVALID_RECORD');
    expect(code(() => run(avail(item('a', NaN))))).toBe('INVALID_RECORD');
    expect(code(() => run(avail({ ...item('a', 1), citation: null as never })))).toBe('INVALID_RECORD');
  });

  it('validates every item citation, not only the first', () => {
    const bad: Record<string, unknown>[] = [
      { datasetVersion: 4 }, { datasetVersion: '3' },
      ...(['sourceId', 'chunkId', 'blockId'] as const).flatMap((k) => ['', 1, null, undefined].map((v) => ({ [k]: v }))),
      ...(['startLine', 'endLine'] as const).flatMap((k) => [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined].map((v) => ({ [k]: v }))),
      { startLine: 5, endLine: 4 },
    ];
    for (const over of bad) {
      const ok = item('a', 2);
      const broken = { ...item('b', 1), citation: { ...ok.citation, ...over } };
      expect(code(() => run(avail(ok, broken))), JSON.stringify(over)).toBe('INVALID_RECORD');
    }
    expect(code(() => run(avail({ ...item('a', 2), citation: {} as never })))).toBe('INVALID_RECORD');
  });

  it('accepts valid citations, including equal start and end lines', () => {
    const a = item('a', 2);
    expect(code(() => run(avail({ ...a, citation: { ...a.citation, startLine: 7, endLine: 7 } })))).toBe('none');
  });
});
