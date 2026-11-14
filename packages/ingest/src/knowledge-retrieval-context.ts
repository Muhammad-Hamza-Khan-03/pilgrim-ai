import { KnowledgeRetrievalError, MAX_KNOWLEDGE_RETRIEVAL_LIMIT } from './in-memory-knowledge-retrieval.js';
import type { KnowledgeRetrievalHit, KnowledgeRetrievalProvenance, KnowledgeRetrievalResult } from './knowledge-retrieval.js';

export const DEFAULT_KNOWLEDGE_CONTEXT_MAX_CHARACTERS_PER_ITEM = 2000;
export const DEFAULT_KNOWLEDGE_CONTEXT_MAX_TOTAL_CHARACTERS = 8000;

export type KnowledgeRetrievalContextRequest = Readonly<{
  datasetVersion: number;
  results: KnowledgeRetrievalResult;
  limit: number;
  maxCharactersPerItem?: number;
  maxTotalCharacters?: number;
}>;

export type KnowledgeRetrievalContextCitation = Readonly<KnowledgeRetrievalProvenance>;

export type KnowledgeRetrievalContextItem = Readonly<{
  recordId: string;
  text: string;
  score: number;
  citation: KnowledgeRetrievalContextCitation;
}>;

export type KnowledgeRetrievalContextAvailableResult = Readonly<{
  status: 'available';
  datasetVersion: number;
  items: readonly KnowledgeRetrievalContextItem[];
  totalCharacters: number;
}>;

export type KnowledgeRetrievalContextUnavailableResult = Readonly<{
  status: 'unavailable';
  reason: 'index-unavailable';
  items: readonly [];
  totalCharacters: 0;
}>;

export type KnowledgeRetrievalContextResult = KnowledgeRetrievalContextAvailableResult | KnowledgeRetrievalContextUnavailableResult;

export interface KnowledgeRetrievalContextProjector {
  project(request: KnowledgeRetrievalContextRequest): KnowledgeRetrievalContextResult;
}

export type KnowledgeRetrievalContextProjectorOptions = Readonly<{
  maxCharactersPerItem?: number;
  maxTotalCharacters?: number;
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

// Cut at a UTF-16 length without leaving a dangling high surrogate.
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function validateHit(hit: KnowledgeRetrievalHit, datasetVersion: number): void {
  const p = hit?.provenance;
  if (!hit || !nonEmpty(hit.recordId) || !nonEmpty(hit.text) || typeof hit.score !== 'number' || !Number.isFinite(hit.score)) throw invalidRecord('hit is malformed');
  if (!p || p.datasetVersion !== datasetVersion || !nonEmpty(p.sourceId) || !nonEmpty(p.chunkId) || !nonEmpty(p.blockId)
    || !Number.isSafeInteger(p.startLine) || !Number.isSafeInteger(p.endLine) || p.startLine < 1 || p.endLine < p.startLine) {
    throw invalidRecord('hit provenance is malformed or from another dataset version');
  }
}

export function createKnowledgeRetrievalContextProjector(options: KnowledgeRetrievalContextProjectorOptions = {}): KnowledgeRetrievalContextProjector {
  return {
    project(request) {
      const { datasetVersion, limit, results } = request;
      if (!Number.isSafeInteger(datasetVersion) || datasetVersion < 0) throw invalidRequest('datasetVersion must be a nonnegative safe integer');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_KNOWLEDGE_RETRIEVAL_LIMIT) throw invalidRequest(`limit must be an integer from 1 to ${MAX_KNOWLEDGE_RETRIEVAL_LIMIT}`);
      const perItem = bound(request.maxCharactersPerItem ?? options.maxCharactersPerItem, DEFAULT_KNOWLEDGE_CONTEXT_MAX_CHARACTERS_PER_ITEM, 'maxCharactersPerItem');
      const total = bound(request.maxTotalCharacters ?? options.maxTotalCharacters, DEFAULT_KNOWLEDGE_CONTEXT_MAX_TOTAL_CHARACTERS, 'maxTotalCharacters');
      if (results?.status === 'unavailable') return Object.freeze({ status: 'unavailable', reason: 'index-unavailable', items: Object.freeze([]) as readonly [], totalCharacters: 0 });
      if (results?.status !== 'available' || results.datasetVersion !== datasetVersion || !Array.isArray(results.results)) throw invalidRecord('results are malformed or from another dataset version');

      const seen = new Set<string>();
      for (const hit of results.results) {
        validateHit(hit, datasetVersion);
        if (seen.has(hit.recordId)) throw new KnowledgeRetrievalError('DUPLICATE_RECORD_ID', `duplicate recordId ${hit.recordId}`);
        seen.add(hit.recordId);
      }
      const sorted = [...results.results].sort((a, b) => b.score - a.score || compare(a.recordId, b.recordId)
        || compare(a.provenance.sourceId, b.provenance.sourceId) || compare(a.provenance.blockId, b.provenance.blockId)
        || a.provenance.startLine - b.provenance.startLine || a.provenance.endLine - b.provenance.endLine
        || compare(a.provenance.chunkId, b.provenance.chunkId)).slice(0, limit);

      const items: KnowledgeRetrievalContextItem[] = [];
      let used = 0;
      for (const hit of sorted) {
        const text = truncate(truncate(hit.text!, perItem), total - used);
        if (text.length === 0) break;
        const { datasetVersion: dv, sourceId, chunkId, blockId, startLine, endLine } = hit.provenance;
        items.push(Object.freeze({ recordId: hit.recordId, text, score: hit.score, citation: Object.freeze({ datasetVersion: dv, sourceId, chunkId, blockId, startLine, endLine }) }));
        used += text.length;
      }
      return Object.freeze({ status: 'available', datasetVersion, items: Object.freeze(items), totalCharacters: used });
    },
  };
}
