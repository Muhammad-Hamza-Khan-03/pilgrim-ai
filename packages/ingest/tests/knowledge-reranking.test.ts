import { describe, expect, it } from 'vitest';
import { KnowledgeRetrievalError, MAX_KNOWLEDGE_RETRIEVAL_LIMIT } from '../src/in-memory-knowledge-retrieval.js';
import { createDeterministicKnowledgeReranker } from '../src/knowledge-reranking.js';
import type { KnowledgeRetrievalHit, KnowledgeRetrievalResult } from '../src/knowledge-retrieval.js';

const hit = (recordId: string, score: number, text: string | undefined, over: Partial<KnowledgeRetrievalHit['provenance']> = {}): KnowledgeRetrievalHit => ({
  recordId, score, ...(text === undefined ? {} : { text }), provenance: { datasetVersion: 3, sourceId: 's', chunkId: `c-${recordId}`, blockId: 'b', startLine: 1, endLine: 2, ...over },
});
const ok = (...results: KnowledgeRetrievalHit[]): KnowledgeRetrievalResult => ({ status: 'available', datasetVersion: 3, results });
const run = (results: KnowledgeRetrievalResult, extra: object = {}, opts = {}) =>
  createDeterministicKnowledgeReranker(opts).rerank({ datasetVersion: 3, query: 'Hotel Near HARAM', results, limit: 10, ...extra });
const ids = (r: KnowledgeRetrievalResult) => r.results.map((h) => h.recordId);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as KnowledgeRetrievalError).code; } return 'none'; };

describe('deterministic knowledge reranker', () => {
  it('lexical relevance beats retrieval score; score is secondary tie-break', () => {
    const r = run(ok(hit('a', 99, 'unrelated'), hit('b', 1, 'hotel near the haram'), hit('c', 5, 'HOTEL only'), hit('d', 7, 'hotel only')));
    expect(ids(r)).toEqual(['b', 'd', 'c', 'a']);
    expect(r.results[0]!.score).toBe(1);
  });

  it('ties break by recordId then provenance; limit applies after sort', () => {
    const r = run(ok(hit('b', 1, 'x'), hit('a', 1, 'x', { sourceId: 'z' }), hit('a2', 1, 'x'), hit('z', 1, 'haram')), { limit: 3 });
    expect(ids(r)).toEqual(['z', 'a', 'a2']);
  });

  it('counts distinct terms and honours term bounds', () => {
    expect(ids(run(ok(hit('a', 1, 'hotel hotel hotel'), hit('b', 1, 'hotel haram'))))).toEqual(['b', 'a']);
    expect(ids(run(ok(hit('a', 1, 'x haram'), hit('b', 2, 'x y')), {}, { maxTextTerms: 1 }))).toEqual(['b', 'a']);
    expect(ids(run(ok(hit('a', 1, 'haram'), hit('b', 2, 'hotel')), {}, { maxQueryTerms: 1 }))).toEqual(['b', 'a']);
  });

  it('keeps unavailable and empty available as-is', () => {
    expect(run({ status: 'unavailable', reason: 'index-unavailable', results: [] })).toEqual({ status: 'unavailable', reason: 'index-unavailable', results: [] });
    expect(run(ok())).toEqual({ status: 'available', datasetVersion: 3, results: [] });
  });

  it('does not mutate input and output is detached', () => {
    const input = ok(hit('a', 1, 'x'), hit('b', 1, 'hotel'));
    const snapshot = structuredClone(input);
    const r = run(input);
    expect(input).toEqual(snapshot);
    expect(r.results[0]).toEqual(snapshot.results[1]);
    expect(r.results[0]).not.toBe(input.results[1]);
    expect(r.results[0]!.provenance).not.toBe(input.results[1]!.provenance);
  });

  it('rejects invalid requests and records', () => {
    expect(code(() => run(ok(), { datasetVersion: -1 }))).toBe('INVALID_REQUEST');
    expect(code(() => run(ok(), { query: '' }))).toBe('INVALID_REQUEST');
    expect(code(() => run(ok(), { query: 5 }))).toBe('INVALID_REQUEST');
    expect(code(() => run(ok(), { limit: 0 }))).toBe('INVALID_REQUEST');
    expect(code(() => run(ok(), { limit: MAX_KNOWLEDGE_RETRIEVAL_LIMIT + 1 }))).toBe('INVALID_REQUEST');
    expect(code(() => createDeterministicKnowledgeReranker({ maxQueryTerms: 0 }))).toBe('INVALID_REQUEST');
    expect(code(() => run({ status: 'available', datasetVersion: 4, results: [] }))).toBe('INVALID_RECORD');
    expect(code(() => run({ status: 'unavailable', reason: 'index-unavailable', results: [hit('a', 1, 'x')] } as never))).toBe('INVALID_RECORD');
    expect(code(() => run(ok(hit('a', NaN, 'x'))))).toBe('INVALID_RECORD');
    expect(code(() => run(ok(hit('a', 1, 'x', { datasetVersion: 9 }))))).toBe('INVALID_RECORD');
    expect(code(() => run(ok(hit('a', 1, 'x', { endLine: 0 }))))).toBe('INVALID_RECORD');
    expect(code(() => run(ok(hit('a', 1, 'x'), hit('a', 2, 'y'))))).toBe('DUPLICATE_RECORD_ID');
  });

  it('validates factory options before reading properties', () => {
    expect(() => createDeterministicKnowledgeReranker(undefined)).not.toThrow();
    expect(() => createDeterministicKnowledgeReranker({})).not.toThrow();
    const bad: unknown[] = [null, 'x', '', 1, 0, true, false, 1n, Symbol('s'), () => ({}), [], [{ maxQueryTerms: 2 }]];
    for (const o of bad) {
      let err: unknown;
      try { createDeterministicKnowledgeReranker(o as never); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(KnowledgeRetrievalError);
      expect((err as KnowledgeRetrievalError).code).toBe('INVALID_REQUEST');
    }
    for (const v of [0, -1, 1.5, NaN, Infinity, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(code(() => createDeterministicKnowledgeReranker({ maxQueryTerms: v as never }))).toBe('INVALID_REQUEST');
      expect(code(() => createDeterministicKnowledgeReranker({ maxTextTerms: v as never }))).toBe('INVALID_REQUEST');
    }
  });
});
