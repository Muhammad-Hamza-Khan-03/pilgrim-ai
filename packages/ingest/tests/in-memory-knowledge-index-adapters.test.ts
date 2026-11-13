import { describe, expect, it } from 'vitest';
import {
  KnowledgeIndexAdapterError,
  createDeterministicKnowledgeEmbeddingProvider,
  createInMemoryKnowledgeFtsAdapter,
  createInMemoryKnowledgeVectorStore,
  validateKnowledgeEmbeddingResult,
  type KnowledgeEmbeddingRequest,
  type KnowledgeIndexProjectionBatch,
  type KnowledgeVectorBatch,
} from '../src/index.js';

const record = (id: string, datasetVersion = 7) => ({
  recordId: id,
  chunkId: id,
  datasetVersion,
  sourceId: `source-${id}`,
  blockId: `block-${id}`,
  headingPath: ['Guide'],
  text: `text-${id}`,
  startLine: 1,
  endLine: 2,
  ordinal: Number(id.replace('chunk-', '')) || 0,
});

const batch = (ids = ['chunk-1'], datasetVersion = 7): KnowledgeIndexProjectionBatch => ({
  datasetVersion,
  records: ids.map((id) => record(id, datasetVersion)),
});

const vectorBatch = (ids = ['chunk-1'], datasetVersion = 7): KnowledgeVectorBatch => ({
  datasetVersion,
  dimensions: 2,
  vectors: ids.map((id, index) => ({
    id,
    values: [index + 1, 0],
    metadata: {
      datasetVersion,
      sourceId: `source-${id}`,
      chunkId: id,
      blockId: `block-${id}`,
      startLine: 1,
      endLine: 2,
    },
  })),
});

describe('Phase 2Q local deterministic knowledge-index adapters', () => {
  it('validates embedding model, empty dimensions, cardinality, IDs, dimensions, lengths, and finite values', () => {
    const request: KnowledgeEmbeddingRequest = {
      model: 'local-test-model',
      inputs: [{ recordId: 'chunk-1', text: 'one' }, { recordId: 'chunk-2', text: 'two' }],
    };
    expect(() => validateKnowledgeEmbeddingResult(request, {
      model: request.model,
      dimensions: 2,
      vectors: request.inputs.map(({ recordId }) => ({ recordId, values: [1, 0] })),
    })).not.toThrow();

    expect(() => validateKnowledgeEmbeddingResult({ model: 'm', inputs: [] }, {
      model: 'm', dimensions: 1, vectors: [],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_DIMENSIONS' }));
    expect(() => validateKnowledgeEmbeddingResult(request, {
      model: 'other', dimensions: 2, vectors: request.inputs.map(({ recordId }) => ({ recordId, values: [1, 0] })),
    })).toThrowError(expect.objectContaining({ code: 'EMBEDDING_MODEL_MISMATCH' }));
    expect(() => validateKnowledgeEmbeddingResult(request, {
      model: request.model, dimensions: 2, vectors: [
        { recordId: 'chunk-2', values: [1, 0] }, { recordId: 'chunk-1', values: [1, 0] },
      ],
    })).toThrowError(expect.objectContaining({ code: 'EMBEDDING_ID_MISMATCH' }));
    expect(() => validateKnowledgeEmbeddingResult(request, {
      model: request.model, dimensions: 2, vectors: [
        { recordId: 'chunk-1', values: [1, Number.NaN] }, { recordId: 'chunk-2', values: [1, 0] },
      ],
    })).toThrowError(expect.objectContaining({ code: 'NON_FINITE_VECTOR_VALUE' }));
  });

  it('provides repeatable configured embeddings in request order without mutating the request', async () => {
    const provider = createDeterministicKnowledgeEmbeddingProvider({ model: 'local', dimensions: 3 });
    const request: KnowledgeEmbeddingRequest = {
      model: 'local', inputs: [{ recordId: 'b', text: 'beta' }, { recordId: 'a', text: 'alpha' }],
    };
    const before = structuredClone(request);
    const first = await provider.embed(request);
    const second = await provider.embed(request);
    expect(first).toEqual(second);
    expect(first.vectors.map(({ recordId }) => recordId)).toEqual(['b', 'a']);
    expect(first.vectors.every(({ values }) => values.length === 3)).toBe(true);
    expect(request).toEqual(before);
    await expect(provider.embed({ model: 'wrong', inputs: [] })).rejects.toThrowError(
      expect.objectContaining({ code: 'EMBEDDING_MODEL_MISMATCH' }),
    );
  });

  it('replaces complete FTS staging batches, clones inputs and snapshots, and removes idempotently', async () => {
    const adapter = createInMemoryKnowledgeFtsAdapter();
    const input = batch(['chunk-2', 'chunk-1']);
    await adapter.upsertStaging(input);
    (input.records[0] as { text: string }).text = 'caller mutation';
    await adapter.upsertStaging(batch(['chunk-1']));
    expect(adapter.snapshot()).toEqual([batch(['chunk-1'])]);
    const snapshot = adapter.snapshot();
    (snapshot[0].records[0] as { text: string }).text = 'snapshot mutation';
    expect(adapter.snapshot()).toEqual([batch(['chunk-1'])]);
    await adapter.removeStagingDataset(7);
    await adapter.removeStagingDataset(7);
    expect(adapter.snapshot()).toEqual([]);
    expect(adapter).not.toHaveProperty('activate');
  });

  it('fails closed for invalid FTS batch versions, duplicate IDs, and mismatched record identity', async () => {
    const adapter = createInMemoryKnowledgeFtsAdapter();
    await expect(adapter.upsertStaging({ ...batch(), records: [record('chunk-1', 8)] }))
      .rejects.toThrowError(expect.objectContaining({ code: 'DATASET_VERSION_MISMATCH' }));
    await expect(adapter.upsertStaging(batch(['chunk-1', 'chunk-1'])))
      .rejects.toThrowError(expect.objectContaining({ code: 'DUPLICATE_RECORD_ID' }));
    await expect(adapter.upsertStaging({ ...batch(), records: [{ ...record('chunk-1'), recordId: 'record-1' }] }))
      .rejects.toThrowError(expect.objectContaining({ code: 'DUPLICATE_RECORD_ID' }));
  });

  it('replaces complete vector staging batches, validates metadata and finite vectors, and removes idempotently', async () => {
    const store = createInMemoryKnowledgeVectorStore();
    await store.upsertStaging(vectorBatch(['chunk-2', 'chunk-1']));
    await store.upsertStaging(vectorBatch(['chunk-1']));
    expect(store.snapshot()).toEqual([vectorBatch(['chunk-1'])]);
    await store.removeStagingDataset(7);
    await store.removeStagingDataset(7);
    expect(store.snapshot()).toEqual([]);
    await expect(store.upsertStaging({ ...vectorBatch(), vectors: [{ ...vectorBatch().vectors[0], values: [1, Infinity] }] }))
      .rejects.toThrowError(expect.objectContaining({ code: 'NON_FINITE_VECTOR_VALUE' }));
    await expect(store.upsertStaging({ ...vectorBatch(), dimensions: 3 }))
      .rejects.toThrowError(expect.objectContaining({ code: 'VECTOR_DIMENSION_MISMATCH' }));
    expect(store).not.toHaveProperty('activate');
  });

  it('exposes typed adapter errors', () => {
    const error = new KnowledgeIndexAdapterError('INVALID_DIMENSIONS', 'bad dimensions');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('KnowledgeIndexAdapterError');
    expect(error.code).toBe('INVALID_DIMENSIONS');
  });
});
