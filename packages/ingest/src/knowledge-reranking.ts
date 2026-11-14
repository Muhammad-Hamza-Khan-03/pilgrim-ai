import { KnowledgeRetrievalError, MAX_KNOWLEDGE_RETRIEVAL_LIMIT } from './in-memory-knowledge-retrieval.js';
import type { KnowledgeRetrievalHit, KnowledgeRetrievalResult } from './knowledge-retrieval.js';

export const DEFAULT_KNOWLEDGE_RERANK_MAX_QUERY_TERMS = 32;
export const DEFAULT_KNOWLEDGE_RERANK_MAX_TEXT_TERMS = 2000;

export type KnowledgeRerankRequest = Readonly<{
  datasetVersion: number;
  query: string;
  results: KnowledgeRetrievalResult;
  limit: number;
}>;

export interface KnowledgeReranker {
  rerank(request: KnowledgeRerankRequest): KnowledgeRetrievalResult;
}

export type KnowledgeRerankerOptions = Readonly<{
  maxQueryTerms?: number;
  maxTextTerms?: number;
}>;

const invalidRequest = (message: string) => new KnowledgeRetrievalError('INVALID_REQUEST', message);
const invalidRecord = (message: string) => new KnowledgeRetrievalError('INVALID_RECORD', message);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function bound(value: number | undefined, fallback: number, name: string): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < 1) throw invalidRequest(`${name} must be a positive safe integer`);
  return v;
}

// Lowercase, split on whitespace, keep at most `max` terms (bounded work per hit).
const tokenize = (text: string, max: number): string[] => text.toLowerCase().split(/\s+/).filter((t) => t.length > 0).slice(0, max);

function validateHit(hit: KnowledgeRetrievalHit, datasetVersion: number): void {
  const p = hit?.provenance;
  if (!hit || !nonEmpty(hit.recordId) || typeof hit.score !== 'number' || !Number.isFinite(hit.score) || (hit.text !== undefined && typeof hit.text !== 'string')) throw invalidRecord('hit is malformed');
  if (!p || p.datasetVersion !== datasetVersion || !nonEmpty(p.sourceId) || !nonEmpty(p.chunkId) || !nonEmpty(p.blockId)
    || !Number.isSafeInteger(p.startLine) || !Number.isSafeInteger(p.endLine) || p.startLine < 1 || p.endLine < p.startLine) {
    throw invalidRecord('hit provenance is malformed or from another dataset version');
  }
}

/**
 * Score semantics: the rerank score is the number of DISTINCT query terms (first maxQueryTerms,
 * lowercased, whitespace-tokenized) that appear among the first maxTextTerms terms of the hit text.
 * The returned hit `score` stays the original retrieval score; it is only a secondary tie-break.
 * Order: rerank score desc, original score desc, recordId, then provenance fields.
 */
export function createDeterministicKnowledgeReranker(options: KnowledgeRerankerOptions = {}): KnowledgeReranker {
  const maxQuery = bound(options.maxQueryTerms, DEFAULT_KNOWLEDGE_RERANK_MAX_QUERY_TERMS, 'maxQueryTerms');
  const maxText = bound(options.maxTextTerms, DEFAULT_KNOWLEDGE_RERANK_MAX_TEXT_TERMS, 'maxTextTerms');
  return {
    rerank(request) {
      if (!request || typeof request !== 'object') throw invalidRequest('request must be an object');
      const { datasetVersion, query, limit, results } = request;
      if (!Number.isSafeInteger(datasetVersion) || datasetVersion < 0) throw invalidRequest('datasetVersion must be a nonnegative safe integer');
      if (!nonEmpty(query)) throw invalidRequest('query must be a non-empty string');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_KNOWLEDGE_RETRIEVAL_LIMIT) throw invalidRequest(`limit must be an integer from 1 to ${MAX_KNOWLEDGE_RETRIEVAL_LIMIT}`);
      if (results?.status === 'unavailable') {
        if (results.reason !== 'index-unavailable' || !Array.isArray(results.results) || results.results.length !== 0) throw invalidRecord('unavailable result is malformed');
        return structuredClone(results);
      }
      if (results?.status !== 'available' || results.datasetVersion !== datasetVersion || !Array.isArray(results.results)) throw invalidRecord('results are malformed or from another dataset version');

      const seen = new Set<string>();
      for (const hit of results.results) {
        validateHit(hit, datasetVersion);
        if (seen.has(hit.recordId)) throw new KnowledgeRetrievalError('DUPLICATE_RECORD_ID', `duplicate recordId ${hit.recordId}`);
        seen.add(hit.recordId);
      }
      const terms = new Set(tokenize(query, maxQuery));
      const ranked = results.results.map((hit) => {
        const words = new Set(hit.text === undefined ? [] : tokenize(hit.text, maxText));
        let relevance = 0;
        for (const t of terms) if (words.has(t)) relevance++;
        return { hit, relevance };
      }).sort((a, b) => b.relevance - a.relevance || b.hit.score - a.hit.score || compare(a.hit.recordId, b.hit.recordId)
        || compare(a.hit.provenance.sourceId, b.hit.provenance.sourceId) || compare(a.hit.provenance.blockId, b.hit.provenance.blockId)
        || a.hit.provenance.startLine - b.hit.provenance.startLine || a.hit.provenance.endLine - b.hit.provenance.endLine
        || compare(a.hit.provenance.chunkId, b.hit.provenance.chunkId)).slice(0, limit);
      return { status: 'available', datasetVersion, results: structuredClone(ranked.map((r) => r.hit)) };
    },
  };
}
