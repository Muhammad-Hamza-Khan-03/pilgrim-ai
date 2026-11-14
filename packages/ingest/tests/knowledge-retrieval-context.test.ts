import { describe, expect, it } from 'vitest';
import { createKnowledgeRetrievalContextProjector } from '../src/knowledge-retrieval-context.js';
import type { KnowledgeRetrievalHit, KnowledgeRetrievalResult } from '../src/knowledge-retrieval.js';

const hit = (recordId: string, score: number, text = 'text', over: Partial<KnowledgeRetrievalHit['provenance']> = {}): KnowledgeRetrievalHit => ({
  recordId, score, text, provenance: { datasetVersion: 3, sourceId: 's', chunkId: `c-${recordId}`, blockId: 'b', startLine: 1, endLine: 2, ...over },
});
const ok = (...results: KnowledgeRetrievalHit[]): KnowledgeRetrievalResult => ({ status: 'available', datasetVersion: 3, results });
const run = (results: KnowledgeRetrievalResult, extra: object = {}) =>
  createKnowledgeRetrievalContextProjector().project({ datasetVersion: 3, results, limit: 10, ...extra });

describe('knowledge retrieval context projector', () => {
  it('orders deterministically, applies limit, preserves citation and score', () => {
    const r = run(ok(hit('b', 1), hit('a', 1), hit('c', 5)), { limit: 2 });
    expect(r).toMatchObject({ status: 'available', datasetVersion: 3, totalCharacters: 8 });
    if (r.status !== 'available') throw new Error();
    expect(r.items.map((i) => i.recordId)).toEqual(['c', 'a']);
    expect(r.items[0]).toEqual({ recordId: 'c', text: 'text', score: 5, citation: { datasetVersion: 3, sourceId: 's', chunkId: 'c-c', blockId: 'b', startLine: 1, endLine: 2 } });
  });

  it('truncates per item and total without exceeding budget or splitting surrogates', () => {
    const r = run(ok(hit('a', 3, 'abcdefgh'), hit('b', 2, 'ijklmnop'), hit('c', 1, 'qrstuvwx')), { maxCharactersPerItem: 5, maxTotalCharacters: 8 });
    if (r.status !== 'available') throw new Error();
    expect(r.items.map((i) => i.text)).toEqual(['abcde', 'ijk']);
    expect(r.totalCharacters).toBe(8);
    const s = run(ok(hit('a', 1, 'a😀')), { maxCharactersPerItem: 2 });
    if (s.status !== 'available') throw new Error();
    expect(s.items[0]!.text).toBe('a');
  });

  it('returns empty unavailable result without throwing', () => {
    expect(run({ status: 'unavailable', reason: 'index-unavailable', results: [] })).toEqual({ status: 'unavailable', reason: 'index-unavailable', items: [], totalCharacters: 0 });
  });

  it('output is frozen and detached from input', () => {
    const input = hit('a', 1);
    const r = run(ok(input));
    if (r.status !== 'available') throw new Error();
    expect(Object.isFrozen(r.items) && Object.isFrozen(r.items[0]!.citation)).toBe(true);
    expect(r.items[0]!.citation).not.toBe(input.provenance);
  });

  it('fails closed on bad requests and hits', () => {
    const p = createKnowledgeRetrievalContextProjector();
    const base = { datasetVersion: 3, results: ok(hit('a', 1)), limit: 1 };
    for (const bad of [{ datasetVersion: -1 }, { datasetVersion: 1.5 }, { limit: 0 }, { limit: 101 }, { maxCharactersPerItem: 0 }, { maxTotalCharacters: 1.5 }, { datasetVersion: 4 }]) {
      expect(() => p.project({ ...base, ...bad })).toThrow();
    }
    const bads = [hit('', 1), hit('a', 1, ''), hit('a', Number.NaN), hit('a', Infinity), hit('a', 1, 't', { datasetVersion: 2 }),
      hit('a', 1, 't', { sourceId: '' }), hit('a', 1, 't', { startLine: 0 }), hit('a', 1, 't', { startLine: 3, endLine: 2 }), { ...hit('a', 1), text: undefined }];
    for (const b of bads) expect(() => run(ok(b))).toThrow();
    expect(() => run(ok(hit('a', 1), hit('a', 2)))).toThrow(/duplicate/);
  });
});
