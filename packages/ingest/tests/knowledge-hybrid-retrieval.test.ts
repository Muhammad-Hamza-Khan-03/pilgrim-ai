import { describe, expect, it, vi } from 'vitest';
import { KnowledgeRetrievalError } from '../src/in-memory-knowledge-retrieval.js';
import { createInMemoryHybridKnowledgeRetriever } from '../src/knowledge-hybrid-retrieval.js';
import type { KnowledgeRetrievalHit, KnowledgeRetrievalResult } from '../src/knowledge-retrieval.js';

const hit = (recordId: string, text: string): KnowledgeRetrievalHit => ({
  recordId, score: 99, text, provenance: { datasetVersion: 3, sourceId: 's', chunkId: `c-${recordId}`, blockId: recordId, startLine: 1, endLine: 2 },
});
const ok = (...results: KnowledgeRetrievalHit[]): KnowledgeRetrievalResult => ({ status: 'available', datasetVersion: 3, results });
const down: KnowledgeRetrievalResult = { status: 'unavailable', reason: 'index-unavailable', results: [] };
const setup = (k: KnowledgeRetrievalResult, v: KnowledgeRetrievalResult) => {
  const keyword = { search: vi.fn(() => k) };
  const vector = { search: vi.fn(() => v) };
  return { keyword, vector, hybrid: createInMemoryHybridKnowledgeRetriever(keyword, vector) };
};
const base = { datasetVersion: 3, keywordQuery: 'q', vectorQuery: [1], limit: 10 };

describe('Phase 2V hybrid retrieval', () => {
  it('fuses by RRF, prefers keyword payload, and passes defaults to both retrievers', () => {
    const { hybrid, keyword, vector } = setup(ok(hit('a', 'kw'), hit('b', 'kw')), ok(hit('b', 'vec'), hit('c', 'vec')));
    const out = hybrid.search({ ...base, limit: 5 });
    expect(keyword.search).toHaveBeenCalledWith({ datasetVersion: 3, query: 'q', limit: 5 });
    expect(vector.search).toHaveBeenCalledWith({ datasetVersion: 3, query: [1], limit: 5 });
    expect(out.results.map((r) => [r.recordId, r.text])).toEqual([['b', 'kw'], ['a', 'kw'], ['c', 'vec']]);
    expect(out.results[0].score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(out.results[1].score).toBeCloseTo(1 / 61, 12);
  });

  it('breaks ties by recordId and applies limit after sorting', () => {
    const { hybrid } = setup(ok(hit('z', 'k')), ok(hit('a', 'v')));
    expect(hybrid.search({ ...base, limit: 1 }).results.map((r) => r.recordId)).toEqual(['a']);
  });

  it('honors custom rrfK and per-source limits', () => {
    const { hybrid, keyword, vector } = setup(ok(hit('a', 'k')), ok());
    const out = hybrid.search({ ...base, keywordLimit: 2, vectorLimit: 3, rrfK: 1 });
    expect(keyword.search.mock.calls[0][0].limit).toBe(2);
    expect(vector.search.mock.calls[0][0].limit).toBe(3);
    expect(out.results[0].score).toBeCloseTo(1 / 2, 12);
  });

  it('falls back when one side is unavailable; both unavailable is unavailable', () => {
    expect(setup(down, ok(hit('v', 'v'))).hybrid.search(base)).toMatchObject({ status: 'available', results: [{ recordId: 'v' }] });
    expect(setup(ok(hit('k', 'k')), down).hybrid.search(base)).toMatchObject({ status: 'available', results: [{ recordId: 'k' }] });
    expect(setup(down, down).hybrid.search(base)).toEqual(down);
  });

  it('handles empty sets and propagates typed retriever errors', () => {
    expect(setup(ok(), ok()).hybrid.search(base)).toEqual({ status: 'available', datasetVersion: 3, results: [] });
    const err = new KnowledgeRetrievalError('INVALID_REQUEST', 'boom');
    const hybrid = createInMemoryHybridKnowledgeRetriever({ search: () => { throw err; } }, { search: () => ok() });
    expect(() => hybrid.search(base)).toThrow(err);
  });

  it('uses configured default rrfK, validates it, and merges equal ids with keyword provenance', () => {
    const kw = { search: () => ok(hit('a', 'k')) };
    const vec = { search: () => ok() };
    expect(createInMemoryHybridKnowledgeRetriever(kw, vec, { rrfK: 9 }).search(base).results[0].score).toBeCloseTo(1 / 10, 12);
    expect(() => createInMemoryHybridKnowledgeRetriever(kw, vec, { rrfK: 0 })).toThrow(KnowledgeRetrievalError);
    const lo = { ...hit('t', 'v'), provenance: { ...hit('t', 'v').provenance, sourceId: 'a' } };
    const hi = { ...hit('t', 'k'), provenance: { ...hit('t', 'k').provenance, sourceId: 'b' } };
    const out = createInMemoryHybridKnowledgeRetriever({ search: () => ok(hi) }, { search: () => ok(lo) }).search(base).results;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ text: 'k', provenance: { sourceId: 'b' } });
  });

  it('fails closed on duplicate recordIds regardless of order or payload', () => {
    const a = hit('d', 'one');
    const b = { ...hit('d', 'two'), score: 1 };
    for (const dup of [[a, b], [b, a], [a, a]]) {
      for (const side of ['keyword', 'vector'] as const) {
        const { hybrid } = side === 'keyword' ? setup(ok(...dup), ok()) : setup(ok(), ok(...dup));
        expect(() => hybrid.search(base)).toThrow(expect.objectContaining({ code: 'DUPLICATE_RECORD_ID' }));
      }
    }
  });

  it('fails closed when any hit belongs to another dataset version', () => {
    const stray = { ...hit('x', 'k'), provenance: { ...hit('x', 'k').provenance, datasetVersion: 4 } };
    expect(() => setup(ok(hit('a', 'k'), stray), ok()).hybrid.search(base)).toThrow(expect.objectContaining({ code: 'INVALID_RECORD' }));
    expect(() => setup(ok(), ok(stray)).hybrid.search(base)).toThrow(KnowledgeRetrievalError);
  });

  it('rejects invalid requests before calling retrievers', () => {
    const { hybrid, keyword } = setup(ok(), ok());
    for (const bad of [
      { ...base, limit: 0 }, { ...base, limit: 101 }, { ...base, datasetVersion: -1 }, { ...base, keywordLimit: 1.5 },
      { ...base, vectorLimit: 101 }, { ...base, rrfK: 0 }, { ...base, rrfK: 1001 }, { ...base, keywordQuery: 1 as unknown as string },
      { ...base, vectorQuery: [NaN] },
    ]) expect(() => hybrid.search(bad)).toThrow(KnowledgeRetrievalError);
    expect(keyword.search).not.toHaveBeenCalled();
  });
});
