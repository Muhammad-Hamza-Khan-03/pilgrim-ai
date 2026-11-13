import type {
  KnowledgeEmbeddingProvider,
  KnowledgeEmbeddingRequest,
  KnowledgeEmbeddingResult,
  KnowledgeFtsProjectionAdapter,
  KnowledgeIndexProjectionBatch,
  KnowledgeVectorBatch,
  KnowledgeVectorStore,
} from './knowledge-index-adapters.js';

export const KNOWLEDGE_INDEX_ADAPTER_ERROR_CODES = [
  'DATASET_VERSION_MISMATCH',
  'DUPLICATE_RECORD_ID',
  'DUPLICATE_VECTOR_ID',
  'EMBEDDING_MODEL_MISMATCH',
  'EMBEDDING_CARDINALITY_MISMATCH',
  'EMBEDDING_ID_MISMATCH',
  'INVALID_DIMENSIONS',
  'VECTOR_DIMENSION_MISMATCH',
  'VECTOR_METADATA_MISMATCH',
  'NON_FINITE_VECTOR_VALUE',
] as const;

export type KnowledgeIndexAdapterErrorCode = typeof KNOWLEDGE_INDEX_ADAPTER_ERROR_CODES[number];

export class KnowledgeIndexAdapterError extends Error {
  readonly code: KnowledgeIndexAdapterErrorCode;

  constructor(code: KnowledgeIndexAdapterErrorCode, message: string) {
    super(message);
    this.name = 'KnowledgeIndexAdapterError';
    this.code = code;
  }
}

const fail = (code: KnowledgeIndexAdapterErrorCode, message: string): never => {
  throw new KnowledgeIndexAdapterError(code, message);
};

const isNonnegativeInteger = (value: number): boolean => Number.isInteger(value) && value >= 0;

/** Validates a provider response without changing either caller-owned value. */
export function validateKnowledgeEmbeddingResult(
  request: KnowledgeEmbeddingRequest,
  result: KnowledgeEmbeddingResult,
): void {
  if (result.model !== request.model) fail('EMBEDDING_MODEL_MISMATCH', 'embedding model does not match the request');
  if (!isNonnegativeInteger(result.dimensions)) fail('INVALID_DIMENSIONS', 'embedding dimensions must be a nonnegative integer');
  if (result.vectors.length !== request.inputs.length) {
    fail('EMBEDDING_CARDINALITY_MISMATCH', 'embedding result cardinality does not match the request');
  }
  if (request.inputs.length === 0 && result.dimensions !== 0) {
    fail('INVALID_DIMENSIONS', 'empty embedding results must have zero dimensions');
  }

  const seen = new Set<string>();
  result.vectors.forEach((vector, index) => {
    if (seen.has(vector.recordId)) fail('EMBEDDING_ID_MISMATCH', `duplicate embedding result ID at index ${index}`);
    seen.add(vector.recordId);
    if (vector.recordId !== request.inputs[index]?.recordId) {
      fail('EMBEDDING_ID_MISMATCH', `embedding result ID at index ${index} does not match the request`);
    }
    if (vector.values.length !== result.dimensions) {
      fail('VECTOR_DIMENSION_MISMATCH', `embedding vector at index ${index} has the wrong length`);
    }
    if (vector.values.some((value) => !Number.isFinite(value))) {
      fail('NON_FINITE_VECTOR_VALUE', `embedding vector at index ${index} contains a non-finite value`);
    }
  });
}

export type DeterministicKnowledgeEmbeddingProviderOptions = {
  readonly model: string;
  readonly dimensions: number;
};

/** A local test double; its values are stable identifiers, not semantic embeddings. */
export function createDeterministicKnowledgeEmbeddingProvider(
  options: DeterministicKnowledgeEmbeddingProviderOptions,
): KnowledgeEmbeddingProvider {
  if (!isNonnegativeInteger(options.dimensions)) {
    fail('INVALID_DIMENSIONS', 'configured embedding dimensions must be a nonnegative integer');
  }
  return {
    async embed(request): Promise<KnowledgeEmbeddingResult> {
      if (request.model !== options.model) {
        fail('EMBEDDING_MODEL_MISMATCH', 'embedding model does not match the configured provider model');
      }
      const vectors = request.inputs.map(({ recordId, text }) => {
        let state = 2166136261;
        for (const char of `${recordId}\u0000${text}`) {
          state ^= char.codePointAt(0) ?? 0;
          state = Math.imul(state, 16777619);
        }
        const values = Array.from({ length: options.dimensions }, (_, index) => {
          state = Math.imul(state ^ (index + 1), 16777619);
          return ((state >>> 0) / 0xffffffff) * 2 - 1;
        });
        return { recordId, values };
      });
      const result = { model: options.model, dimensions: request.inputs.length === 0 ? 0 : options.dimensions, vectors };
      validateKnowledgeEmbeddingResult(request, result);
      return structuredClone(result);
    },
  };
}
