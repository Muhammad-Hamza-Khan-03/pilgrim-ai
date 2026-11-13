import type { MarkdownKnowledgeStagingResult } from './markdown-knowledge-staging.js';
import { materializeKnowledgeIndex } from './knowledge-index-materialization.js';
import type {
  KnowledgeEmbeddingResult,
  KnowledgeFtsProjectionAdapter,
  KnowledgeIndexProjectionBatch,
  KnowledgeEmbeddingProvider,
  KnowledgeVectorBatch,
  KnowledgeVectorStore,
} from './knowledge-index-adapters.js';
import { validateKnowledgeEmbeddingResult } from './knowledge-index-adapter-validation.js';

export type KnowledgeIndexStagingPipelineRequest = {
  readonly staging: MarkdownKnowledgeStagingResult;
  readonly model: string;
  readonly fts: KnowledgeFtsProjectionAdapter;
  readonly embeddings: KnowledgeEmbeddingProvider;
  readonly vectors: KnowledgeVectorStore;
};

export type KnowledgeIndexStagingPipelineResult = {
  readonly status: 'staging';
  readonly indexed: false;
  readonly datasetVersion: number;
  readonly projection: KnowledgeIndexProjectionBatch;
  readonly embedding: KnowledgeEmbeddingResult;
  readonly vectorBatch: KnowledgeVectorBatch;
  readonly rejected: ReturnType<typeof materializeKnowledgeIndex>['rejected'];
  readonly sources: string[];
};

const clone = <T>(value: T): T => structuredClone(value);

export async function stageKnowledgeIndex(
  request: KnowledgeIndexStagingPipelineRequest,
): Promise<KnowledgeIndexStagingPipelineResult> {
  const materialized = materializeKnowledgeIndex({ staging: request.staging });
  const projection: KnowledgeIndexProjectionBatch = {
    datasetVersion: materialized.datasetVersion,
    records: materialized.records.map(({ recordId, chunkId, datasetVersion, sourceId, blockId, headingPath, text, startLine, endLine, ordinal }) => ({
      recordId, chunkId, datasetVersion, sourceId, blockId, headingPath, text, startLine, endLine, ordinal,
    })),
  };
  const embeddingRequest = {
    model: request.model,
    inputs: projection.records.map(({ recordId, text }) => ({ recordId, text })),
  };
  const embedding = await request.embeddings.embed(embeddingRequest);
  validateKnowledgeEmbeddingResult(embeddingRequest, embedding);

  const recordsById = new Map(projection.records.map((record) => [record.recordId, record]));
  const vectorBatch: KnowledgeVectorBatch = {
    datasetVersion: projection.datasetVersion,
    dimensions: embedding.dimensions,
    vectors: embedding.vectors.map(({ recordId, values }) => {
      const record = recordsById.get(recordId);
      if (!record) throw new Error(`embedding returned an unknown record ID: ${recordId}`);
      return {
        id: recordId,
        values: [...values],
        metadata: {
          datasetVersion: record.datasetVersion,
          sourceId: record.sourceId,
          chunkId: record.chunkId,
          blockId: record.blockId,
          startLine: record.startLine,
          endLine: record.endLine,
        },
      };
    }),
  };

  await request.fts.upsertStaging(clone(projection));
  await request.vectors.upsertStaging(clone(vectorBatch));

  return clone({
    status: 'staging' as const,
    indexed: false as const,
    datasetVersion: materialized.datasetVersion,
    projection,
    embedding,
    vectorBatch,
    rejected: materialized.rejected,
    sources: materialized.sources,
  });
}
