import { describe, expect, it } from 'vitest';
import {
  chunkMarkdownDocument,
  createDeterministicKnowledgeEmbeddingProvider,
  createInMemoryKnowledgeFtsAdapter,
  createInMemoryKnowledgeVectorStore,
  createInMemorySourceArtifactStore,
  ingestMarkdownSource,
  materializeKnowledgeIndex,
  stageKnowledgeIndex,
  stageMarkdownKnowledge,
  type KnowledgeEmbeddingProvider,
  type KnowledgeEmbeddingRequest,
  type KnowledgeEmbeddingResult,
} from '../src/index.js';

const MARKDOWN = '# Pilgrim Guide\n\nIntro prose.\n\n## Local indexing\n\nKnowledge stays local.\n\n```ts\nconst answer = 42;\n```\n\n### Acceptance\n\nStable records matter.\n';
const SOURCE_SHA = 'a827242e181ba917cabb983c3fbb0c5af4f4cbfc3145527d89e5a08023862540';
const DATASET_VERSION = 42;
const MODEL = 'local-knowledge-test-model';
const DIMENSIONS = 4;

async function buildStaging() {
  const source = await ingestMarkdownSource({
    store: createInMemorySourceArtifactStore(),
    bytes: MARKDOWN,
    filename: 'pilgrim-guide.md',
  });
  const chunks = chunkMarkdownDocument(source.document, { maxChars: 200, overlapChars: 0 });
  const staging = stageMarkdownKnowledge({
    datasetVersion: DATASET_VERSION,
    chunks: [...chunks, { ...chunks[0] }],
  });
  return { source, chunks, staging };
}

function capturingProvider(requests: KnowledgeEmbeddingRequest[]): KnowledgeEmbeddingProvider {
  const deterministic = createDeterministicKnowledgeEmbeddingProvider({ model: MODEL, dimensions: DIMENSIONS });
  return {
    async embed(request): Promise<KnowledgeEmbeddingResult> {
      requests.push(structuredClone(request));
      return deterministic.embed(request);
    },
  };
}

function pipelineRequest(
  staging: Awaited<ReturnType<typeof buildStaging>>['staging'],
  fts: ReturnType<typeof createInMemoryKnowledgeFtsAdapter>,
  vectors: ReturnType<typeof createInMemoryKnowledgeVectorStore>,
  embeddings: KnowledgeEmbeddingProvider,
) {
  return { staging, model: MODEL, fts, vectors, embeddings };
}

describe('Phase 2S local end-to-end knowledge acceptance', () => {
  it('accepts a Markdown source through staging, materialization, embeddings, FTS, and vectors', async () => {
    const { source, chunks, staging } = await buildStaging();

    expect(source.manifest).toMatchObject({
      sourceId: SOURCE_SHA,
      sha256: SOURCE_SHA,
      byteLength: 143,
      kind: 'markdown',
      key: `sources/sha256/${SOURCE_SHA}`,
    });
    expect(source.artifact.bytes).toEqual(new TextEncoder().encode(MARKDOWN));
    expect(source.document.blocks.map(({ headingPath, startLine, endLine }) => ({ headingPath, startLine, endLine }))).toEqual([
      { headingPath: ['Pilgrim Guide'], startLine: 2, endLine: 4 },
      { headingPath: ['Pilgrim Guide', 'Local indexing'], startLine: 6, endLine: 12 },
      { headingPath: ['Pilgrim Guide', 'Local indexing', 'Acceptance'], startLine: 14, endLine: 16 },
    ]);
    expect(chunks).toHaveLength(3);
    expect(chunks.map(({ headingPath, startLine, endLine }) => ({ headingPath, startLine, endLine }))).toEqual([
      { headingPath: ['Pilgrim Guide'], startLine: 2, endLine: 4 },
      { headingPath: ['Pilgrim Guide', 'Local indexing'], startLine: 6, endLine: 12 },
      { headingPath: ['Pilgrim Guide', 'Local indexing', 'Acceptance'], startLine: 15, endLine: 15 },
    ]);
    expect(staging.status).toBe('staging');
    expect(staging.indexed).toBe(false);
    expect(staging.datasetVersion).toBe(DATASET_VERSION);
    expect(staging.chunks).toHaveLength(3);
    expect(staging.rejected).toHaveLength(1);
    expect(staging.rejected[0]).toMatchObject({ code: 'DUPLICATE_CHUNK_ID', blockId: chunks[0].blockId });

    const materialized = materializeKnowledgeIndex({ staging });
    expect(materialized.records).toHaveLength(staging.chunks.length);
    expect(materialized.records.every(({ recordId, chunkId, datasetVersion }) => recordId === chunkId && datasetVersion === DATASET_VERSION)).toBe(true);
    expect(materialized.rejected).toEqual(staging.rejected);

    const fts = createInMemoryKnowledgeFtsAdapter();
    const vectors = createInMemoryKnowledgeVectorStore();
    const requests: KnowledgeEmbeddingRequest[] = [];
    const result = await stageKnowledgeIndex(pipelineRequest(staging, fts, vectors, capturingProvider(requests)));

    expect(result.status).toBe('staging');
    expect(result.indexed).toBe(false);
    expect(result.datasetVersion).toBe(DATASET_VERSION);
    expect(result.projection.records).toHaveLength(3);
    expect(result.projection.records.every(({ recordId, chunkId, datasetVersion }) => recordId === chunkId && datasetVersion === DATASET_VERSION)).toBe(true);
    expect(requests).toEqual([{
      model: MODEL,
      inputs: result.projection.records.map(({ recordId, text }) => ({ recordId, text })),
    }]);
    expect(result.embedding).toMatchObject({ model: MODEL, dimensions: DIMENSIONS });
    expect(result.embedding.vectors.map(({ recordId }) => recordId)).toEqual(result.projection.records.map(({ recordId }) => recordId));
    expect(result.vectorBatch.vectors).toHaveLength(result.projection.records.length);
    expect(result.vectorBatch.vectors.every(({ id, metadata }) => id === metadata.chunkId && metadata.datasetVersion === DATASET_VERSION)).toBe(true);
    expect(result.vectorBatch.vectors.map(({ metadata }) => ({ sourceId: metadata.sourceId, chunkId: metadata.chunkId, blockId: metadata.blockId, startLine: metadata.startLine, endLine: metadata.endLine }))).toEqual(
      result.projection.records.map(({ sourceId, chunkId, blockId, startLine, endLine }) => ({ sourceId, chunkId, blockId, startLine, endLine })),
    );
    expect(result.rejected).toEqual(staging.rejected);
    expect(result.sources).toEqual([SOURCE_SHA]);
    expect(fts.snapshot()).toEqual([result.projection]);
    expect(vectors.snapshot()).toEqual([result.vectorBatch]);
    expect(fts.snapshot()[0].records.some(({ recordId }) => result.rejected.some(({ blockId }) => blockId === recordId))).toBe(false);
    expect(vectors.snapshot()[0].vectors.some(({ id }) => result.rejected.some(({ blockId }) => blockId === id))).toBe(false);
  });

  it('is deterministic under permutation and protects source, staging, result, and adapter values from aliasing', async () => {
    const first = await buildStaging();
    const permuted = {
      ...first.staging,
      chunks: [...first.staging.chunks].reverse(),
      rejected: [...first.staging.rejected].reverse(),
      sources: [...first.staging.sources].reverse(),
    };
    const firstFts = createInMemoryKnowledgeFtsAdapter();
    const firstVectors = createInMemoryKnowledgeVectorStore();
    const secondFts = createInMemoryKnowledgeFtsAdapter();
    const secondVectors = createInMemoryKnowledgeVectorStore();
    const [left, right] = await Promise.all([
      stageKnowledgeIndex(pipelineRequest(first.staging, firstFts, firstVectors, capturingProvider([]))),
      stageKnowledgeIndex(pipelineRequest(permuted, secondFts, secondVectors, capturingProvider([]))),
    ]);

    expect(left).toEqual(right);
    const originalSource = structuredClone(first.source);
    const originalStaging = structuredClone(first.staging);
    (left.projection.records[0].headingPath as string[]).push('mutated');
    (left.vectorBatch.vectors[0].values as number[])[0] = 999;
    left.rejected[0].message = 'mutated';
    expect(first.source).toEqual(originalSource);
    expect(first.staging).toEqual(originalStaging);
    expect(right.projection.records[0].headingPath).not.toContain('mutated');
    expect(firstFts.snapshot()[0].records[0].headingPath).not.toContain('mutated');
    expect(firstVectors.snapshot()[0].vectors[0].values).not.toContain(999);
  });

  it('replaces a repeated dataset run rather than accumulating duplicate adapter batches', async () => {
    const { staging } = await buildStaging();
    const fts = createInMemoryKnowledgeFtsAdapter();
    const vectors = createInMemoryKnowledgeVectorStore();
    await stageKnowledgeIndex(pipelineRequest(staging, fts, vectors, capturingProvider([])));
    const repeated = await stageKnowledgeIndex(pipelineRequest(staging, fts, vectors, capturingProvider([])));
    expect(fts.snapshot()).toEqual([repeated.projection]);
    expect(vectors.snapshot()).toEqual([repeated.vectorBatch]);
  });

  it('validates invalid embeddings before either adapter writes', async () => {
    const { staging } = await buildStaging();
    const fts = createInMemoryKnowledgeFtsAdapter();
    const vectors = createInMemoryKnowledgeVectorStore();
    const invalid: KnowledgeEmbeddingProvider = {
      async embed(request) {
        return { model: request.model, dimensions: 1, vectors: request.inputs.map(({ recordId }) => ({ recordId, values: [Number.NaN] })) };
      },
    };
    await expect(stageKnowledgeIndex(pipelineRequest(staging, fts, vectors, invalid))).rejects.toMatchObject({ code: 'NON_FINITE_VECTOR_VALUE' });
    expect(fts.snapshot()).toEqual([]);
    expect(vectors.snapshot()).toEqual([]);
  });

  it('propagates adapter failures and documents the current non-atomic second-adapter behavior', async () => {
    const { staging } = await buildStaging();
    const provider = capturingProvider([]);
    const ftsError = new Error('fts failed');
    const failingFts = {
      ...createInMemoryKnowledgeFtsAdapter(),
      async upsertStaging(): Promise<void> { throw ftsError; },
    };
    await expect(stageKnowledgeIndex(pipelineRequest(staging, failingFts, createInMemoryKnowledgeVectorStore(), provider))).rejects.toBe(ftsError);

    const vectorError = new Error('vector failed');
    const fts = createInMemoryKnowledgeFtsAdapter();
    const failingVectors = {
      ...createInMemoryKnowledgeVectorStore(),
      async upsertStaging(): Promise<void> { throw vectorError; },
    };
    await expect(stageKnowledgeIndex(pipelineRequest(staging, fts, failingVectors, provider))).rejects.toBe(vectorError);
    // Phase 2S deliberately preserves the existing sequential adapter contract: if the
    // second adapter fails, the first write remains visible. Atomic rollback is Phase 2T.
    expect(fts.snapshot()).toHaveLength(1);
    expect(failingVectors.snapshot()).toEqual([]);
  });
});
