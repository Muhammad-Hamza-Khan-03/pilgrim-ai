import { KnowledgeRetrievalError, MAX_KNOWLEDGE_RETRIEVAL_LIMIT } from './in-memory-knowledge-retrieval.js';
import type {
  KnowledgeKeywordRetriever,
  KnowledgeRetrievalHit,
  KnowledgeRetrievalResult,
  KnowledgeVectorRetriever,
} from './knowledge-retrieval.js';

export const DEFAULT_KNOWLEDGE_RRF_K = 60;
export const MAX_KNOWLEDGE_RRF_K = 1000;

export type KnowledgeHybridSearchRequest = Readonly<{
  datasetVersion: number;
  keywordQuery: string;
  vectorQuery: readonly number[];
  limit: number;
  keywordLimit?: number;
  vectorLimit?: number;
  rrfK?: number;
}>;

export interface KnowledgeHybridRetriever {
  search(request: KnowledgeHybridSearchRequest): KnowledgeRetrievalResult;
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const invalid = (message: string): never => { throw new KnowledgeRetrievalError('INVALID_REQUEST', message); };

function boundedInt(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${name} must be an integer from ${min} to ${max}`);
  return value as number;
}

function order(left: KnowledgeRetrievalHit, right: KnowledgeRetrievalHit): number {
  return right.score - left.score
    || compare(left.recordId, right.recordId)
    || compare(left.provenance.sourceId, right.provenance.sourceId)
    || compare(left.provenance.blockId, right.provenance.blockId)
    || left.provenance.startLine - right.provenance.startLine
    || left.provenance.endLine - right.provenance.endLine
    || compare(left.provenance.chunkId, right.provenance.chunkId);
}

export type KnowledgeHybridRetrieverOptions = Readonly<{ rrfK?: number }>;

export function createInMemoryHybridKnowledgeRetriever(
  keywordRetriever: KnowledgeKeywordRetriever,
  vectorRetriever: KnowledgeVectorRetriever,
  options: KnowledgeHybridRetrieverOptions = {},
): KnowledgeHybridRetriever {
  if (!options || typeof options !== 'object') invalid('options must be an object');
  const defaultRrfK = boundedInt('rrfK', options.rrfK ?? DEFAULT_KNOWLEDGE_RRF_K, 1, MAX_KNOWLEDGE_RRF_K);
  return {
    search(request) {
      if (!request || typeof request !== 'object') invalid('request must be an object');
      const datasetVersion = boundedInt('datasetVersion', request.datasetVersion, 0, Number.MAX_SAFE_INTEGER);
      const limit = boundedInt('limit', request.limit, 1, MAX_KNOWLEDGE_RETRIEVAL_LIMIT);
      const keywordLimit = boundedInt('keywordLimit', request.keywordLimit ?? limit, 1, MAX_KNOWLEDGE_RETRIEVAL_LIMIT);
      const vectorLimit = boundedInt('vectorLimit', request.vectorLimit ?? limit, 1, MAX_KNOWLEDGE_RETRIEVAL_LIMIT);
      const rrfK = boundedInt('rrfK', request.rrfK ?? defaultRrfK, 1, MAX_KNOWLEDGE_RRF_K);
      if (typeof request.keywordQuery !== 'string') invalid('keywordQuery must be a string');
      if (!Array.isArray(request.vectorQuery) || request.vectorQuery.some((value) => !Number.isFinite(value))) invalid('vectorQuery must be an array of finite numbers');

      const keyword = keywordRetriever.search({ datasetVersion, query: request.keywordQuery, limit: keywordLimit });
      const vector = vectorRetriever.search({ datasetVersion, query: request.vectorQuery, limit: vectorLimit });
      if (keyword.status === 'unavailable' && vector.status === 'unavailable') return { status: 'unavailable', reason: 'index-unavailable', results: [] };

      const merged = new Map<string, KnowledgeRetrievalHit>();
      // keyword is merged first so its payload wins on overlap
      for (const result of [keyword, vector]) {
        const seen = new Set<string>();
        result.results.forEach((item, index) => {
          if (item.provenance?.datasetVersion !== datasetVersion) throw new KnowledgeRetrievalError('INVALID_RECORD', `hit ${item.recordId} is outside dataset ${datasetVersion}`);
          // any duplicate fails closed: first-seen-wins would make output depend on result order
          if (seen.has(item.recordId)) throw new KnowledgeRetrievalError('DUPLICATE_RECORD_ID', `duplicate recordId ${item.recordId} in retriever result`);
          seen.add(item.recordId);
          const contribution = 1 / (rrfK + index + 1);
          const existing = merged.get(item.recordId);
          merged.set(item.recordId, existing
            ? { ...existing, score: existing.score + contribution }
            : { ...structuredClone(item), score: contribution });
        });
      }
      return { status: 'available', datasetVersion, results: [...merged.values()].sort(order).slice(0, limit) };
    },
  };
}
