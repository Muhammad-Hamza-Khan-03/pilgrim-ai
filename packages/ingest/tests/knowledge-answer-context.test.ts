import { describe, expect, it } from 'vitest';
import { KnowledgeRetrievalError } from '../src/in-memory-knowledge-retrieval.js';
import { createKnowledgeAnswerContextBuilder } from '../src/knowledge-answer-context.js';
import { createKnowledgeRetrievalContextProjector } from '../src/knowledge-retrieval-context.js';
import type { KnowledgeRetrievalHit, KnowledgeRetrievalResult } from '../src/knowledge-retrieval.js';

const hit = (recordId: string, score: number, text: string, datasetVersion = 3): KnowledgeRetrievalHit => ({
  recordId, score, text, provenance: { datasetVersion, sourceId: 's', chunkId: `c-${recordId}`, blockId: 'b', startLine: 1, endLine: 2 },
});
const avail = (...results: KnowledgeRetrievalHit[]): KnowledgeRetrievalResult => ({ status: 'available', datasetVersion: 3, results });
const req = (results: unknown, extra: Record<string, unknown> = {}) =>
  ({ datasetVersion: 3, query: 'hajj visa', results, limit: 5, minScore: 0.5, ...extra }) as never;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof KnowledgeRetrievalError ? e.code : 'other'; } return 'none'; };

describe('knowledge answer context builder', () => {
  it('reranks lexically, keeps that order in context, and gates', () => {
    const r = createKnowledgeAnswerContextBuilder().prepare(req(avail(hit('a', 0.9, 'unrelated'), hit('b', 0.6, 'hajj visa rules'))));
    if (r.status !== 'ready') throw new Error(r.status);
    expect(r.items.map((i) => i.recordId)).toEqual(['b', 'a']);
    expect(r.topScore).toBe(0.6);
    expect(r.items[0]!.citation).toEqual({ datasetVersion: 3, sourceId: 's', chunkId: 'c-b', blockId: 'b', startLine: 1, endLine: 2 });
    expect(Object.isFrozen(r) && Object.isFrozen(r.items[0]!.citation)).toBe(true);
  });

  it('applies limit and character caps, UTF-16 safe, and does not mutate input', () => {
    const input = avail(hit('a', 1, 'hajj😀😀 visa'), hit('b', 1, 'zzz'));
    const snap = structuredClone(input);
    const r = createKnowledgeAnswerContextBuilder().prepare(req(input, { limit: 1, maxCharactersPerItem: 5 }));
    if (r.status !== 'ready') throw new Error(r.status);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.text).toBe('hajj'); // cut before dangling high surrogate
    expect(input).toEqual(snap);
  });

  it('reports insufficient and unavailable', () => {
    const b = createKnowledgeAnswerContextBuilder();
    expect(b.prepare(req(avail(hit('a', 0.1, 'x')))).status).toBe('insufficient');
    expect(b.prepare(req(avail())).status).toBe('insufficient');
    expect(b.prepare(req({ status: 'unavailable', reason: 'index-unavailable', results: [] }))).toMatchObject({ status: 'unavailable', datasetVersion: 3 });
  });

  it('rejects hostile input with typed errors', () => {
    const b = createKnowledgeAnswerContextBuilder();
    const bad = (r: unknown) => code(() => b.prepare(r as never));
    for (const r of [null, undefined, 1, 'x']) expect(bad(r)).toBe('INVALID_REQUEST');
    expect(bad(req(avail(), { datasetVersion: -1 }))).toBe('INVALID_REQUEST');
    expect(bad(req(avail(), { query: '' }))).toBe('INVALID_REQUEST');
    expect(bad(req(avail(), { limit: 0 }))).toBe('INVALID_REQUEST');
    for (const m of [NaN, Infinity, '1', undefined]) expect(bad(req(avail(hit('a', 1, 'x')), { minScore: m }))).toBe('INVALID_REQUEST');
    for (const k of ['maxQueryTerms', 'maxTextTerms', 'maxCharactersPerItem', 'maxTotalCharacters']) expect(bad(req(avail(), { [k]: 0 }))).toBe('INVALID_REQUEST');
    expect(bad(req(null))).toBe('INVALID_RECORD');
    expect(bad(req(avail(hit('a', 1, 'x', 4))))).toBe('INVALID_RECORD');
    expect(bad(req(avail(null as never)))).toBe('INVALID_RECORD');
    expect(bad(req(avail(hit('a', NaN, 'x'))))).toBe('INVALID_RECORD');
    expect(bad(req(avail({ ...hit('a', 1, 'x'), provenance: null as never })))).toBe('INVALID_RECORD');
    expect(bad(req(avail(hit('a', 1, 'x'), hit('a', 2, 'y'))))).toBe('DUPLICATE_RECORD_ID');
    expect(bad(req(avail({ ...hit('a', 1, 'x'), text: undefined })))).toBe('INVALID_RECORD');
  });

  it('rejects bad builder options', () => {
    for (const o of [null, [], 'x', { maxQueryTerms: 0 }, { maxTextTerms: 1.5 }, { maxCharactersPerItem: -1 }, { maxTotalCharacters: NaN }]) {
      expect(code(() => createKnowledgeAnswerContextBuilder(o as never))).toBe('INVALID_REQUEST');
    }
  });
});

describe('projector order option', () => {
  const results = avail(hit('lo', 1, 'a'), hit('hi', 9, 'b'));
  const ids = (order?: 'score' | 'input') => (createKnowledgeRetrievalContextProjector(order ? { order } : {}).project({ datasetVersion: 3, results, limit: 2 }) as { items: { recordId: string }[] }).items.map((i) => i.recordId);
  it('defaults to score order; input preserves upstream order', () => {
    expect(ids()).toEqual(['hi', 'lo']);
    expect(ids('score')).toEqual(['hi', 'lo']);
    expect(ids('input')).toEqual(['lo', 'hi']);
  });
  it('validates order, options and request', () => {
    expect(code(() => createKnowledgeRetrievalContextProjector({ order: 'x' } as never))).toBe('INVALID_REQUEST');
    expect(code(() => createKnowledgeRetrievalContextProjector(null as never))).toBe('INVALID_REQUEST');
    expect(code(() => createKnowledgeRetrievalContextProjector().project(null as never))).toBe('INVALID_REQUEST');
  });
});
