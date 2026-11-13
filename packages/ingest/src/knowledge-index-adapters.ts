/** Provider-neutral projection and indexing contracts for the Phase 2P boundary. */

export interface KnowledgeIndexProjectionRecord {
  readonly recordId: string;
  readonly chunkId: string;
  readonly datasetVersion: number;
  readonly sourceId: string;
  readonly blockId: string;
  readonly headingPath: readonly string[];
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly ordinal: number;
}

export interface KnowledgeIndexProjectionBatch {
  readonly datasetVersion: number;
  readonly records: readonly KnowledgeIndexProjectionRecord[];
}

export interface KnowledgeFtsProjectionAdapter {
  upsertStaging(batch: KnowledgeIndexProjectionBatch): Promise<void>;
  removeStagingDataset(datasetVersion: number): Promise<void>;
}

export interface KnowledgeEmbeddingInput {
  readonly recordId: string;
  readonly text: string;
}

export interface KnowledgeEmbeddingRequest {
  readonly model: string;
  readonly inputs: readonly KnowledgeEmbeddingInput[];
}

export interface KnowledgeEmbeddingResult {
  readonly model: string;
  readonly dimensions: number;
  readonly vectors: readonly {
    readonly recordId: string;
    readonly values: readonly number[];
  }[];
}

export interface KnowledgeEmbeddingProvider {
  embed(request: KnowledgeEmbeddingRequest): Promise<KnowledgeEmbeddingResult>;
}

export interface KnowledgeVectorMetadata {
  readonly datasetVersion: number;
  readonly sourceId: string;
  readonly chunkId: string;
  readonly blockId: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface KnowledgeVector {
  readonly id: string;
  readonly values: readonly number[];
  readonly metadata: KnowledgeVectorMetadata;
}

export interface KnowledgeVectorBatch {
  readonly datasetVersion: number;
  readonly dimensions: number;
  readonly vectors: readonly KnowledgeVector[];
}

export interface KnowledgeVectorStore {
  upsertStaging(batch: KnowledgeVectorBatch): Promise<void>;
  removeStagingDataset(datasetVersion: number): Promise<void>;
}
