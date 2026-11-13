import { describe, expect, it } from 'vitest';
import {
  createInMemoryKnowledgeFtsAdapter,
  createInMemoryKnowledgeVectorStore,
  stageKnowledgeIndex,
  type KnowledgeEmbeddingProvider,
  type KnowledgeEmbeddingRequest,
  type KnowledgeEmbeddingResult,
  type MarkdownKnowledgeStagingResult,
  type StagedMarkdownChunk,
} from '../src/index.js';

function staging(overrides: Partial<MarkdownKnowledgeStagingResult> = {}): MarkdownKnowledgeStagingResult {
  const chunk = (chunkId: string, sourceId: string, ordinal: number): StagedMarkdownChunk => ({
    chunkId, sourceId, blockId: `block-${chunkId}`, headingPath: ['Guide'], text: `text-${chunkId}`,
    startLine: ordinal + 1, endLine: ordinal + 2, ordinal, datasetVersion: 7,
    status: 'staging', indexed: false,
  });
  return {
    status: 'staging', datasetVersion: 7, indexed: false,
    chunks: [chunk('chunk-b', 'source-b', 1), chunk('chunk-a', 'source-a', 0)],
    rejected: [{ code: 'DUPLICATE_CHUNK_ID', sourceId: 'source-rejected', blockId: 'block-rejected', message: 'duplicate' }],
    sources: ['source-b', 'source-rejected'], ...overrides,
  };
}

function provider(onRequest: (request: KnowledgeEmbeddingRequest) => void = () => {}): KnowledgeEmbeddingProvider {
  return { async embed(request): Promise<KnowledgeEmbeddingResult> {
    onRequest(request);
    return {
      model: request.model,
      dimensions: request.inputs.length === 0 ? 0 : 2,
      vectors: request.inputs.map(({ recordId }) => ({ recordId, values: [recordId === 'chunk-a' ? 1 : 0, 1] })),
    };
  } };
}

describe('Phase 2R local knowledge-index staging pipeline', () => {
  it('materializes deterministic projection, embeds accepted records only, and writes exact vector metadata', async () => {
    const fts = createInMemoryKnowledgeFtsAdapter();
    const vectors = createInMemoryKnowledgeVectorStore();
    const requests: KnowledgeEmbeddingRequest[] = [];
    const result = await stageKnowledgeIndex({ staging: staging(), model: 'local-model', fts, embeddings: provider((request) => requests.push(request)), vectors });

    expect(result.status).toBe('staging');
    expect(result.indexed).toBe(false);
    expect(result.datasetVersion).toBe(7);
    expect(result.projection.records.map(({ recordId }) => recordId)).toEqual(['chunk-a', 'chunk-b']);
    expect(result.projection.records.every(({ recordId, chunkId }) => recordId === chunkId)).toBe(true);
    expect(requests).toEqual([{ model: 'local-model', inputs: [
      { recordId: 'chunk-a', text: 'text-chunk-a' }, { recordId: 'chunk-b', text: 'text-chunk-b' },
    ] }]);
    expect(result.embedding.model).toBe('local-model');
    expect(result.vectorBatch).toEqual({
      datasetVersion: 7, dimensions: 2, vectors: [
        { id: 'chunk-a', values: [1, 1], metadata: { datasetVersion: 7, sourceId: 'source-a', chunkId: 'chunk-a', blockId: 'block-chunk-a', startLine: 1, endLine: 2 } },
        { id: 'chunk-b', values: [0, 1], metadata: { datasetVersion: 7, sourceId: 'source-b', chunkId: 'chunk-b', blockId: 'block-chunk-b', startLine: 2, endLine: 3 } },
      ],
    });
    expect(result.rejected).toEqual(staging().rejected);
    expect(result.sources).toEqual(['source-a', 'source-b', 'source-rejected']);
    expect(fts.snapshot()[0]).toEqual(result.projection);
    expect(vectors.snapshot()[0]).toEqual(result.vectorBatch);
  });

  it('is invariant to input permutation and does not alias inputs or outputs', async () => {
    const original = staging();
    const reversed = { ...original, chunks: [...original.chunks].reverse(), rejected: [...original.rejected].reverse(), sources: [...original.sources].reverse() };
    const first = await stageKnowledgeIndex({ staging: original, model: 'model', fts: createInMemoryKnowledgeFtsAdapter(), embeddings: provider(), vectors: createInMemoryKnowledgeVectorStore() });
    const second = await stageKnowledgeIndex({ staging: reversed, model: 'model', fts: createInMemoryKnowledgeFtsAdapter(), embeddings: provider(), vectors: createInMemoryKnowledgeVectorStore() });
    expect(first).toEqual(second);
    first.projection.records[0].headingPath.push('mutated');
    first.rejected[0].message = 'mutated';
    expect(original).toEqual(staging());
    expect(second.projection.records[0].headingPath).toEqual(['Guide']);
  });

  it('writes valid empty staging batches with zero-dimensional embeddings', async () => {
    const fts = createInMemoryKnowledgeFtsAdapter();
    const vectors = createInMemoryKnowledgeVectorStore();
    const result = await stageKnowledgeIndex({ staging: staging({ chunks: [], rejected: [], sources: [] }), model: 'model', fts, embeddings: provider(), vectors });
    expect(result.embedding).toEqual({ model: 'model', dimensions: 0, vectors: [] });
    expect(result.vectorBatch).toEqual({ datasetVersion: 7, dimensions: 0, vectors: [] });
    expect(fts.snapshot()).toEqual([{ datasetVersion: 7, records: [] }]);
    expect(vectors.snapshot()).toEqual([{ datasetVersion: 7, dimensions: 0, vectors: [] }]);
  });

  it('validates provider errors before any adapter writes and propagates provider/adapter errors', async () => {
    const fts = createInMemoryKnowledgeFtsAdapter();
    const vectors = createInMemoryKnowledgeVectorStore();
    const badProvider: KnowledgeEmbeddingProvider = { async embed(request) {
      return { model: request.model, dimensions: 1, vectors: request.inputs.map(({ recordId }) => ({ recordId, values: [NaN] })) };
    } };
    await expect(stageKnowledgeIndex({ staging: staging(), model: 'model', fts, embeddings: badProvider, vectors })).rejects.toMatchObject({ code: 'NON_FINITE_VECTOR_VALUE' });
    expect(fts.snapshot()).toEqual([]);
    expect(vectors.snapshot()).toEqual([]);

    const error = new Error('adapter failed');
    const failingFts = { ...createInMemoryKnowledgeFtsAdapter(), upsertStaging: async () => { throw error; } };
    await expect(stageKnowledgeIndex({ staging: staging(), model: 'model', fts: failingFts, embeddings: provider(), vectors: createInMemoryKnowledgeVectorStore() })).rejects.toBe(error);
  });
});
