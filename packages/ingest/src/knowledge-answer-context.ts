import { KnowledgeRetrievalError } from './in-memory-knowledge-retrieval.js';
import { createKnowledgeRetrievalContextGate } from './knowledge-retrieval-context-gate.js';
import type { KnowledgeRetrievalContextGateResult } from './knowledge-retrieval-context-gate.js';
import { createKnowledgeRetrievalContextProjector } from './knowledge-retrieval-context.js';
import { createDeterministicKnowledgeReranker } from './knowledge-reranking.js';
import type { KnowledgeRetrievalResult } from './knowledge-retrieval.js';

export type KnowledgeAnswerContextBuilderOptions = Readonly<{
  maxQueryTerms?: number;
  maxTextTerms?: number;
  maxCharactersPerItem?: number;
  maxTotalCharacters?: number;
}>;

export type KnowledgeAnswerContextRequest = Readonly<{
  datasetVersion: number;
  query: string;
  results: KnowledgeRetrievalResult;
  limit: number;
  minScore: number;
}> & KnowledgeAnswerContextBuilderOptions;

export interface KnowledgeAnswerContextBuilder {
  prepare(request: KnowledgeAnswerContextRequest): KnowledgeRetrievalContextGateResult;
}

const invalidRequest = (message: string) => new KnowledgeRetrievalError('INVALID_REQUEST', message);

// Rerank -> project (keeping rerank order) -> gate. Component validation supplies all typed errors.
export function createKnowledgeAnswerContextBuilder(options: KnowledgeAnswerContextBuilderOptions = {}): KnowledgeAnswerContextBuilder {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw invalidRequest('options must be an object');
  // Eagerly validate option bounds; prepare() re-creates components only to apply per-request overrides.
  createDeterministicKnowledgeReranker({ maxQueryTerms: options.maxQueryTerms, maxTextTerms: options.maxTextTerms });
  createKnowledgeRetrievalContextProjector({ maxCharactersPerItem: options.maxCharactersPerItem, maxTotalCharacters: options.maxTotalCharacters });
  const gate = createKnowledgeRetrievalContextGate();
  const projector = createKnowledgeRetrievalContextProjector({ order: 'input' });
  return {
    prepare(request) {
      if (request === null || typeof request !== 'object') throw invalidRequest('request must be an object');
      const { datasetVersion, query, results, limit, minScore } = request;
      const pick = <K extends keyof KnowledgeAnswerContextBuilderOptions>(k: K) => request[k] ?? options[k];
      const reranker = createDeterministicKnowledgeReranker({ maxQueryTerms: pick('maxQueryTerms'), maxTextTerms: pick('maxTextTerms') });
      const reranked = reranker.rerank({ datasetVersion, query, results, limit });
      const context = projector.project({
        datasetVersion, results: reranked, limit,
        maxCharactersPerItem: pick('maxCharactersPerItem'), maxTotalCharacters: pick('maxTotalCharacters'),
      });
      return gate.evaluate({ datasetVersion, context, minScore });
    },
  };
}
