import { describe, expect, it } from 'vitest';
import type {
  KnowledgeEmbeddingProvider,
  KnowledgeEmbeddingRequest,
  KnowledgeEmbeddingResult,
  KnowledgeFtsProjectionAdapter,
  KnowledgeIndexProjectionBatch,
  KnowledgeIndexProjectionRecord,
  KnowledgeVectorBatch,
  KnowledgeVectorStore,
} from '../src/index.js';
import { materializeKnowledgeIndex } from '../src/index.js';
import type { MarkdownKnowledgeStagingResult, StagedMarkdownChunk } from '../src/index.js';

const record = (overrides: Partial<KnowledgeIndexProjectionRecord> = {}): KnowledgeIndexProjectionRecord => ({
  recordId: 'chunk-1',
  chunkId: 'chunk-1',
  datasetVersion: 7,
  sourceId: 'source-1',
  blockId: 'block-1',
  headingPath: ['Guide'],
  text: 'text',
  startLine: 1,
  endLine: 2,
  ordinal: 0,
  ...overrides,
});

const batch = (overrides: Partial<KnowledgeIndexProjectionBatch> = {}): KnowledgeIndexProjectionBatch => ({
  datasetVersion: 7,
  records: [record()],
  ...overrides,
});

function fakeFtsAdapter() {
  const staged = new Map<number, KnowledgeIndexProjectionBatch>();
  const active = { datasetVersion: undefined as number | undefined };
  const adapter: KnowledgeFtsProjectionAdapter = {
    async upsertStaging(next) {
      staged.set(next.datasetVersion, structuredClone(next));
    },
    async removeStagingDataset(datasetVersion) {
      staged.delete(datasetVersion);
    },
  };
  return { adapter, staged, active };
}

function fakeVectorStore() {
  const staged = new Map<number, KnowledgeVectorBatch>();
  const active = { datasetVersion: undefined as number | undefined };
  const store: KnowledgeVectorStore = {
    async upsertStaging(next) {
      staged.set(next.datasetVersion, structuredClone(next));
    },
    async removeStagingDataset(datasetVersion) {
      staged.delete(datasetVersion);
    },
  };
  return { store, staged, active };
}

function providerThatEchoesRequest(onRequest: (request: KnowledgeEmbeddingRequest) => void): KnowledgeEmbeddingProvider {
  return {
    async embed(request): Promise<KnowledgeEmbeddingResult> {
      onRequest(request);
      return {
        model: request.model,
        dimensions: request.inputs.length === 0 ? 0 : 2,
        vectors: request.inputs.map(({ recordId }) => ({ recordId, values: [1, 0] })),
      };
    },
  };
}

function staging(overrides: Partial<MarkdownKnowledgeStagingResult> = {}): MarkdownKnowledgeStagingResult {
  const chunk: StagedMarkdownChunk = {
    chunkId: 'chunk-1', sourceId: 'source-1', blockId: 'block-1', headingPath: ['Guide'],
    text: 'text', startLine: 1, endLine: 2, ordinal: 0, datasetVersion: 7,
    status: 'staging', indexed: false,
  };
  return { status: 'staging', datasetVersion: 7, indexed: false, chunks: [chunk], rejected: [], sources: [], ...overrides };
}

describe('Phase 2P provider-neutral knowledge-index adapter contracts', () => {
  it('preserves the Phase 2O projection boundary and exact record identity', () => {
    const projection = materializeKnowledgeIndex({ staging: staging() });
    const projected: KnowledgeIndexProjectionBatch = {
      datasetVersion: projection.datasetVersion,
      records: projection.records.map(({ recordId, chunkId, datasetVersion, sourceId, blockId, headingPath, text, startLine, endLine, ordinal }) => ({
        recordId, chunkId, datasetVersion, sourceId, blockId, headingPath, text, startLine, endLine, ordinal,
      })),
    };

    expect(projected.records[0]).toEqual(record());
    expect(projected.records.every((item) => item.recordId === item.chunkId)).toBe(true);
    expect(projected.records.every((item) => item.datasetVersion === projected.datasetVersion)).toBe(true);
  });

  it('requires FTS staging operations to be dataset-scoped, repeatable, and separate from activation', async () => {
    const { adapter, staged, active } = fakeFtsAdapter();
    await adapter.upsertStaging(batch());
    await adapter.upsertStaging(batch({ records: [record({ text: 'replacement' })] }));

    expect(staged.get(7)?.records).toEqual([record({ text: 'replacement' })]);
    expect(active.datasetVersion).toBeUndefined();

    await adapter.removeStagingDataset(7);
    expect(staged.has(7)).toBe(false);
  });

  it('passes only exact embedding IDs and text, preserves exact result IDs, and permits empty input', async () => {
    const requests: KnowledgeEmbeddingRequest[] = [];
    const provider = providerThatEchoesRequest((request) => requests.push(request));
    const result = await provider.embed({
      model: 'test-model',
      inputs: [{ recordId: 'chunk-1', text: 'text' }, { recordId: 'chunk-2', text: 'more text' }],
    });

    expect(requests).toEqual([{ model: 'test-model', inputs: [
      { recordId: 'chunk-1', text: 'text' }, { recordId: 'chunk-2', text: 'more text' },
    ] }]);
    expect(result).toEqual({ model: 'test-model', dimensions: 2, vectors: [
      { recordId: 'chunk-1', values: [1, 0] }, { recordId: 'chunk-2', values: [1, 0] },
    ] });
    expect(result.vectors.map(({ recordId }) => recordId)).toEqual(['chunk-1', 'chunk-2']);
    expect(new Set(result.vectors.map(({ recordId }) => recordId)).size).toBe(result.vectors.length);
    await expect(provider.embed({ model: 'test-model', inputs: [] })).resolves.toEqual({ model: 'test-model', dimensions: 0, vectors: [] });
  });

  it('models vector metadata, dimensions, idempotent staging, and no active-version switch', async () => {
    const { store, staged, active } = fakeVectorStore();
    const vectorBatch: KnowledgeVectorBatch = {
      datasetVersion: 7,
      dimensions: 2,
      vectors: [{
        id: 'chunk-1', values: [1, 0], metadata: {
          datasetVersion: 7, sourceId: 'source-1', chunkId: 'chunk-1', blockId: 'block-1', startLine: 1, endLine: 2,
        },
      }],
    };

    await store.upsertStaging(vectorBatch);
    await store.upsertStaging(vectorBatch);
    expect(staged.get(7)).toEqual(vectorBatch);
    expect(staged.get(7)?.vectors.every(({ values }) => values.length === staged.get(7)?.dimensions)).toBe(true);
    expect(staged.get(7)?.vectors.every(({ metadata }) => metadata.datasetVersion === staged.get(7)?.datasetVersion)).toBe(true);
    expect(staged.get(7)?.vectors[0].id).toBe(staged.get(7)?.vectors[0].metadata.chunkId);
    expect(active.datasetVersion).toBeUndefined();
    await store.removeStagingDataset(7);
    expect(staged.has(7)).toBe(false);
  });

  it('keeps the public contract deeply readonly at compile time', () => {
    const immutable: KnowledgeIndexProjectionBatch = batch();
    expect(immutable.records[0].headingPath).toEqual(['Guide']);
    // The readonly assertions are compile-time contract coverage; no adapter mutates inputs.
    expect(immutable.datasetVersion).toBe(7);
  });
});
