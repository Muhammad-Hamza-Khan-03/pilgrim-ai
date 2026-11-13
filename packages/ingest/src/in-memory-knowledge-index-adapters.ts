import type {
  KnowledgeFtsProjectionAdapter,
  KnowledgeIndexProjectionBatch,
  KnowledgeIndexProjectionRecord,
  KnowledgeVectorBatch,
  KnowledgeVectorStore,
} from './knowledge-index-adapters.js';
import { KnowledgeIndexAdapterError } from './knowledge-index-adapter-validation.js';

const clone = <T>(value: T): T => structuredClone(value);
const isNonnegativeInteger = (value: number): boolean => Number.isInteger(value) && value >= 0;
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const fail = (code: ConstructorParameters<typeof KnowledgeIndexAdapterError>[0], message: string): never => {
  throw new KnowledgeIndexAdapterError(code, message);
};

function validateProjectionBatch(batch: KnowledgeIndexProjectionBatch): void {
  if (!isNonnegativeInteger(batch.datasetVersion)) fail('DATASET_VERSION_MISMATCH', 'dataset version must be a nonnegative integer');
  const ids = new Set<string>();
  for (const record of batch.records) {
    if (record.datasetVersion !== batch.datasetVersion) fail('DATASET_VERSION_MISMATCH', 'record dataset version differs from the batch');
    if (ids.has(record.recordId)) fail('DUPLICATE_RECORD_ID', `duplicate record ID: ${record.recordId}`);
    ids.add(record.recordId);
    if (record.recordId !== record.chunkId) fail('DUPLICATE_RECORD_ID', 'record ID must equal chunk ID');
  }
}

function compareRecord(left: KnowledgeIndexProjectionRecord, right: KnowledgeIndexProjectionRecord): number {
  return compare(left.recordId, right.recordId) || compare(left.sourceId, right.sourceId)
    || compare(left.blockId, right.blockId) || left.startLine - right.startLine
    || left.endLine - right.endLine || left.ordinal - right.ordinal;
}

export type InMemoryKnowledgeFtsAdapter = KnowledgeFtsProjectionAdapter & {
  snapshot(): KnowledgeIndexProjectionBatch[];
  getSnapshot(): KnowledgeIndexProjectionBatch[];
};

export function createInMemoryKnowledgeFtsAdapter(): InMemoryKnowledgeFtsAdapter {
  const staged = new Map<number, KnowledgeIndexProjectionBatch>();
  const snapshot = (): KnowledgeIndexProjectionBatch[] => Array.from(staged.values())
    .sort((left, right) => left.datasetVersion - right.datasetVersion)
    .map((batch) => clone({ ...batch, records: [...batch.records].sort(compareRecord) }));
  return {
    async upsertStaging(batch) {
      validateProjectionBatch(batch);
      staged.set(batch.datasetVersion, clone(batch));
    },
    async removeStagingDataset(datasetVersion) { staged.delete(datasetVersion); },
    snapshot,
    getSnapshot: snapshot,
  };
}

function validateVectorBatch(batch: KnowledgeVectorBatch): void {
  if (!isNonnegativeInteger(batch.datasetVersion)) fail('DATASET_VERSION_MISMATCH', 'dataset version must be a nonnegative integer');
  if (!isNonnegativeInteger(batch.dimensions)) fail('INVALID_DIMENSIONS', 'vector dimensions must be a nonnegative integer');
  const ids = new Set<string>();
  for (const vector of batch.vectors) {
    if (ids.has(vector.id)) fail('DUPLICATE_VECTOR_ID', `duplicate vector ID: ${vector.id}`);
    ids.add(vector.id);
    if (vector.values.length !== batch.dimensions) fail('VECTOR_DIMENSION_MISMATCH', `vector has the wrong length: ${vector.id}`);
    if (vector.values.some((value) => !Number.isFinite(value))) fail('NON_FINITE_VECTOR_VALUE', `vector contains a non-finite value: ${vector.id}`);
    const metadata = vector.metadata;
    if (metadata.datasetVersion !== batch.datasetVersion || metadata.chunkId !== vector.id) {
      fail('VECTOR_METADATA_MISMATCH', `vector metadata does not match vector ${vector.id}`);
    }
  }
}

export type InMemoryKnowledgeVectorStore = KnowledgeVectorStore & {
  snapshot(): KnowledgeVectorBatch[];
  getSnapshot(): KnowledgeVectorBatch[];
};

export function createInMemoryKnowledgeVectorStore(): InMemoryKnowledgeVectorStore {
  const staged = new Map<number, KnowledgeVectorBatch>();
  const snapshot = (): KnowledgeVectorBatch[] => Array.from(staged.values())
    .sort((left, right) => left.datasetVersion - right.datasetVersion)
    .map((batch) => clone({ ...batch, vectors: [...batch.vectors].sort((left, right) => compare(left.id, right.id)) }));
  return {
    async upsertStaging(batch) {
      validateVectorBatch(batch);
      staged.set(batch.datasetVersion, clone(batch));
    },
    async removeStagingDataset(datasetVersion) { staged.delete(datasetVersion); },
    snapshot,
    getSnapshot: snapshot,
  };
}

export const createInMemoryKnowledgeIndexFtsAdapter = createInMemoryKnowledgeFtsAdapter;
export const createInMemoryKnowledgeIndexVectorStore = createInMemoryKnowledgeVectorStore;
