import { describe, expect, it } from 'vitest';
import {
  KnowledgeIndexStagingOrchestrationError,
  orchestrateKnowledgeIndexStaging,
  stageKnowledgeIndex,
  createInMemoryKnowledgeFtsAdapter,
  createInMemoryKnowledgeVectorStore,
  type KnowledgeEmbeddingProvider,
  type KnowledgeEmbeddingRequest,
  type KnowledgeEmbeddingResult,
  type KnowledgeIndexStagingPipelineRequest,
  type MarkdownKnowledgeStagingResult,
  type StagedMarkdownChunk,
} from '../src/index.js';

function request(overrides: Partial<KnowledgeIndexStagingPipelineRequest> = {}): KnowledgeIndexStagingPipelineRequest {
  const chunk: StagedMarkdownChunk = {
    chunkId: 'chunk-a', sourceId: 'source-a', blockId: 'block-a', headingPath: ['Guide'], text: 'text-a',
    startLine: 1, endLine: 2, ordinal: 0, datasetVersion: 7, status: 'staging', indexed: false,
  };
  const staging: MarkdownKnowledgeStagingResult = {
    status: 'staging', datasetVersion: 7, indexed: false, chunks: [chunk], rejected: [], sources: ['source-a'],
  };
  const embeddings: KnowledgeEmbeddingProvider = {
    async embed(input: KnowledgeEmbeddingRequest): Promise<KnowledgeEmbeddingResult> {
      return { model: input.model, dimensions: input.inputs.length ? 2 : 0, vectors: input.inputs.map(({ recordId }) => ({ recordId, values: [1, 2] })) };
    },
  };
  return {
    staging, model: 'model', fts: createInMemoryKnowledgeFtsAdapter(), embeddings,
    vectors: createInMemoryKnowledgeVectorStore(), ...overrides,
  };
}

describe('Phase 2T storage-neutral knowledge-index staging orchestrator', () => {
  it('writes FTS then vector staging and returns a non-indexed staged result', async () => {
    const input = request();
    const events: string[] = [];
    const fts = { ...input.fts, upsertStaging: async (batch: Parameters<typeof input.fts.upsertStaging>[0]) => { events.push('fts'); await input.fts.upsertStaging(batch); } };
    const vectors = { ...input.vectors, upsertStaging: async (batch: Parameters<typeof input.vectors.upsertStaging>[0]) => { events.push('vectors'); await input.vectors.upsertStaging(batch); } };
    const result = await orchestrateKnowledgeIndexStaging({ ...input, fts, vectors });

    expect(result).toMatchObject({ status: 'staged', indexed: false, datasetVersion: 7, writeAttempts: 1, cleanupAttempts: 0, replay: false });
    expect(result.pipeline.status).toBe('staging');
    expect(events).toEqual(['fts', 'vectors']);
  });

  it('cleans both stores and replays the complete write after a vector failure', async () => {
    const input = request();
    const events: string[] = [];
    let vectorWrites = 0;
    const fts = {
      ...input.fts,
      async upsertStaging(batch: Parameters<typeof input.fts.upsertStaging>[0]) { events.push('fts-write'); await input.fts.upsertStaging(batch); },
      async removeStagingDataset(version: number) { events.push(`fts-remove-${version}`); await input.fts.removeStagingDataset(version); },
    };
    const vectors = {
      ...input.vectors,
      async upsertStaging(batch: Parameters<typeof input.vectors.upsertStaging>[0]) { vectorWrites++; events.push('vector-write'); if (vectorWrites === 1) throw new Error('vector failed'); await input.vectors.upsertStaging(batch); },
      async removeStagingDataset(version: number) { events.push(`vector-remove-${version}`); await input.vectors.removeStagingDataset(version); },
    };
    const result = await orchestrateKnowledgeIndexStaging({ ...input, fts, vectors });

    expect(result.writeAttempts).toBe(2);
    expect(result.cleanupAttempts).toBe(1);
    expect(result.replay).toBe(true);
    expect(events).toEqual(['fts-write', 'vector-write', 'fts-remove-7', 'vector-remove-7', 'fts-write', 'vector-write']);
  });

  it('stops with CLEANUP_FAILED and does not retry writes when cleanup cannot complete', async () => {
    const input = request();
    let writes = 0;
    const error = new Error('cleanup unavailable');
    const fts = { ...input.fts, upsertStaging: async () => { writes++; throw new Error('write failed'); }, removeStagingDataset: async () => { throw error; } };
    const vectors = { ...input.vectors, removeStagingDataset: async () => {} };
    await expect(orchestrateKnowledgeIndexStaging({ ...input, fts, vectors }, { maxCleanupAttempts: 2 })).rejects.toMatchObject({
      name: 'KnowledgeIndexStagingOrchestrationError', code: 'CLEANUP_FAILED', datasetVersion: 7, writeAttempts: 1, cleanupAttempts: 2, cause: error,
    });
    expect(writes).toBe(1);
  });

  it('reports exhausted writes after successful cleanup of every contaminated attempt', async () => {
    const input = request();
    let writes = 0;
    const fts = { ...input.fts, upsertStaging: async () => { writes++; throw new Error('write failed'); } };
    await expect(orchestrateKnowledgeIndexStaging({ ...input, fts }, { maxWriteAttempts: 2 })).rejects.toMatchObject({ code: 'RETRY_EXHAUSTED', writeAttempts: 2, cleanupAttempts: 2 });
    expect(writes).toBe(2);
  });

  it('does not write or clean up when embedding validation fails', async () => {
    const input = request({ embeddings: { async embed(input) { return { model: input.model, dimensions: 1, vectors: input.inputs.map(({ recordId }) => ({ recordId, values: [Number.NaN] })) }; } } });
    const fts = { ...input.fts, upsertStaging: async () => { throw new Error('must not write'); }, removeStagingDataset: async () => { throw new Error('must not clean'); } };
    await expect(orchestrateKnowledgeIndexStaging({ ...input, fts })).rejects.toMatchObject({ code: 'NON_FINITE_VECTOR_VALUE' });
  });

  it('validates retry bounds and preserves adapter dataset conflicts as typed orchestration errors', async () => {
    expect(() => orchestrateKnowledgeIndexStaging(request(), { maxWriteAttempts: 0 })).toThrow(RangeError);
    expect(() => orchestrateKnowledgeIndexStaging(request(), { maxCleanupAttempts: 1.5 })).toThrow(RangeError);
    expect(() => orchestrateKnowledgeIndexStaging(request(), { maxWriteAttempts: 101 })).toThrow(RangeError);
    const conflict = Object.assign(new Error('same version'), { code: 'DATASET_CONFLICT' });
    const input = request({ fts: { ...request().fts, upsertStaging: async () => { throw conflict; } } });
    await expect(orchestrateKnowledgeIndexStaging(input)).rejects.toMatchObject({ code: 'DATASET_CONFLICT', cause: conflict, writeAttempts: 1 });
  });

  it('accepts empty staging input', async () => {
    const input = request({ staging: { ...request().staging, chunks: [], sources: [] } });
    const result = await orchestrateKnowledgeIndexStaging(input);
    expect(result.pipeline.vectorBatch).toEqual({ datasetVersion: 7, dimensions: 0, vectors: [] });
  });
});
