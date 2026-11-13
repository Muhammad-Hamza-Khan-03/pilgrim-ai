import { describe, expect, it } from 'vitest';
import {
  KnowledgeRetrievalError,
  createInMemoryKeywordKnowledgeRetriever,
  createInMemoryVectorKnowledgeRetriever,
} from '../src/in-memory-knowledge-retrieval.js';
import type { KnowledgeRetrievalRecord } from '../src/knowledge-retrieval.js';

const provenance = (sourceId: string, blockId: string, startLine = 1) => ({
  datasetVersion: 7, sourceId, chunkId: `${sourceId}-${blockId}`, blockId, startLine, endLine: startLine + 1,
});

function record(recordId: string, text: string, sourceId = 'source-a', blockId = recordId): KnowledgeRetrievalRecord {
  return { recordId, text, provenance: provenance(sourceId, blockId) };
}

describe('Phase 2U deterministic in-memory knowledge retrieval', () => {
  it('tokenizes Unicode-lowercased whitespace terms and ranks deterministically', () => {
    const retriever = createInMemoryKeywordKnowledgeRetriever([
      record('z', 'A UMRAH guide'), record('a', 'umrah umrah'), record('b', 'unrelated'),
    ]);
    expect(retriever.search({ datasetVersion: 7, query: 'UMRAH', limit: 10 })).toEqual({
      status: 'available', datasetVersion: 7, results: [
        { recordId: 'a', score: 2, text: 'umrah umrah', provenance: provenance('source-a', 'a') },
        { recordId: 'z', score: 1, text: 'A UMRAH guide', provenance: provenance('source-a', 'z') },
      ],
    });
  });

  it('supports multiple exact versions and returns an available empty result when absent', () => {
    const one = record('same', 'one');
    const two = { ...record('same', 'two'), provenance: { ...one.provenance, datasetVersion: 8 } };
    const retriever = createInMemoryKeywordKnowledgeRetriever([one, two]);
    expect(retriever.search({ datasetVersion: 9, query: 'one', limit: 2 })).toEqual({ status: 'available', datasetVersion: 9, results: [] });
    expect(retriever.search({ datasetVersion: 8, query: 'two', limit: 2 }).results[0].text).toBe('two');
  });

  it('can explicitly report an unavailable index with empty results', () => {
    const retriever = createInMemoryKeywordKnowledgeRetriever([], { available: false });
    expect(retriever.search({ datasetVersion: 7, query: 'x', limit: 1 })).toEqual({ status: 'unavailable', reason: 'index-unavailable', results: [] });
  });

  it('rejects malformed requests and duplicate IDs fail closed', () => {
    expect(() => createInMemoryKeywordKnowledgeRetriever([record('x', 'x'), record('x', 'y')])).toThrowError(KnowledgeRetrievalError);
    const retriever = createInMemoryKeywordKnowledgeRetriever([record('x', 'x')]);
    expect(() => retriever.search({ datasetVersion: -1, query: 'x', limit: 1 })).toThrowError(KnowledgeRetrievalError);
    expect(() => retriever.search({ datasetVersion: 1, query: 'x', limit: 0 })).toThrowError(KnowledgeRetrievalError);
  });

  it('uses cosine similarity, deterministic ties, and zero norms score zero', () => {
    const records: KnowledgeRetrievalRecord[] = [
      { ...record('b', 'b'), vector: [1, 0] }, { ...record('a', 'a'), vector: [1, 0] }, { ...record('zero', 'zero'), vector: [0, 0] },
    ];
    const retriever = createInMemoryVectorKnowledgeRetriever(records);
    expect(retriever.search({ datasetVersion: 7, query: [1, 0], limit: 5 }).results.map((hit) => [hit.recordId, hit.score])).toEqual([
      ['a', 1], ['b', 1], ['zero', 0],
    ]);
  });

  it('keeps cosine scores finite for very large finite vector components', () => {
    const huge = Number.MAX_VALUE;
    const retriever = createInMemoryVectorKnowledgeRetriever([
      { ...record('aligned', 'aligned'), vector: [huge, huge] },
      { ...record('opposite', 'opposite'), vector: [huge, -huge] },
      { ...record('zero', 'zero'), vector: [0, 0] },
    ]);

    const results = retriever.search({ datasetVersion: 7, query: [huge, huge], limit: 5 }).results;
    expect(results.map((hit) => hit.recordId)).toEqual(['aligned', 'opposite', 'zero']);
    expect(results[0].score).toBeCloseTo(1, 15);
    expect(results.slice(1).map((hit) => hit.score)).toEqual([0, 0]);
    expect(results.every((hit) => Number.isFinite(hit.score))).toBe(true);
  });

  it('rejects nonfinite and dimension-mismatched vectors and isolates inputs/outputs', () => {
    const input = record('x', 'x'); input.vector = [0, 1];
    const retriever = createInMemoryVectorKnowledgeRetriever([input]);
    input.vector[0] = 99;
    const output = retriever.search({ datasetVersion: 7, query: [0, 1], limit: 1 });
    expect(output.results[0].score).toBe(1);
    output.results[0].provenance.sourceId = 'mutated';
    expect(retriever.search({ datasetVersion: 7, query: [0, 1], limit: 1 }).results[0].provenance.sourceId).toBe('source-a');
    expect(() => retriever.search({ datasetVersion: 7, query: [1], limit: 1 })).toThrowError(KnowledgeRetrievalError);
    expect(() => retriever.search({ datasetVersion: 7, query: [Number.NaN, 0], limit: 1 })).toThrowError(KnowledgeRetrievalError);
  });
});
