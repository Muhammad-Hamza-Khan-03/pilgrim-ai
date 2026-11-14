import { KnowledgeRetrievalError } from './in-memory-knowledge-retrieval.js';
import type { KnowledgeRetrievalContextItem, KnowledgeRetrievalContextResult } from './knowledge-retrieval-context.js';

export type KnowledgeRetrievalContextGateRequest = Readonly<{
  datasetVersion: number;
  context: KnowledgeRetrievalContextResult;
  minScore: number;
}>;

export type KnowledgeRetrievalContextGateReadyResult = Readonly<{
  status: 'ready';
  datasetVersion: number;
  items: readonly KnowledgeRetrievalContextItem[];
  totalCharacters: number;
  topScore: number;
}>;

export type KnowledgeRetrievalContextGateInsufficientResult = Readonly<
  | { status: 'insufficient'; reason: 'below-threshold'; datasetVersion: number; items: readonly []; totalCharacters: 0; topScore: number }
  | { status: 'insufficient'; reason: 'no-items'; datasetVersion: number; items: readonly []; totalCharacters: 0 }
>;

export type KnowledgeRetrievalContextGateUnavailableResult = Readonly<{
  status: 'unavailable';
  reason: 'index-unavailable';
  datasetVersion: number;
  items: readonly [];
  totalCharacters: 0;
}>;

export type KnowledgeRetrievalContextGateResult =
  | KnowledgeRetrievalContextGateReadyResult
  | KnowledgeRetrievalContextGateInsufficientResult
  | KnowledgeRetrievalContextGateUnavailableResult;

export interface KnowledgeRetrievalContextGate {
  evaluate(request: KnowledgeRetrievalContextGateRequest): KnowledgeRetrievalContextGateResult;
}

const invalidRequest = (message: string) => new KnowledgeRetrievalError('INVALID_REQUEST', message);
const invalidRecord = (message: string) => new KnowledgeRetrievalError('INVALID_RECORD', message);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function deepFreeze<T>(value: T): T {
  if (isObject(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function validateItem(item: unknown): void {
  const i = item as Record<string, unknown> | null;
  if (!isObject(i) || typeof i.recordId !== 'string' || typeof i.text !== 'string' || typeof i.score !== 'number' || !Number.isFinite(i.score) || !isObject(i.citation)) {
    throw invalidRecord('context item is malformed');
  }
}

export function createKnowledgeRetrievalContextGate(): KnowledgeRetrievalContextGate {
  return {
    evaluate(request) {
      const { datasetVersion, context, minScore } = request ?? ({} as KnowledgeRetrievalContextGateRequest);
      if (!Number.isSafeInteger(datasetVersion) || datasetVersion < 0) throw invalidRequest('datasetVersion must be a nonnegative safe integer');
      if (typeof minScore !== 'number' || !Number.isFinite(minScore)) throw invalidRequest('minScore must be a finite number');
      if (!isObject(context) || !Array.isArray(context.items)) throw invalidRecord('context is malformed');

      if (context.status === 'unavailable') {
        if (context.reason !== 'index-unavailable' || context.items.length !== 0 || context.totalCharacters !== 0) throw invalidRecord('context is malformed');
        return deepFreeze({ status: 'unavailable', reason: 'index-unavailable', datasetVersion, items: [], totalCharacters: 0 });
      }
      if (context.status !== 'available' || context.datasetVersion !== datasetVersion) throw invalidRecord('context is malformed or from another dataset version');
      if (!Number.isSafeInteger(context.totalCharacters) || context.totalCharacters < 0) throw invalidRecord('context totalCharacters is malformed');
      context.items.forEach(validateItem);

      if (context.items.length === 0) {
        if (context.totalCharacters !== 0) throw invalidRecord('context totalCharacters is malformed');
        return deepFreeze({ status: 'insufficient', reason: 'no-items', datasetVersion, items: [], totalCharacters: 0 });
      }
      const topScore = context.items[0]!.score;
      if (topScore < minScore) return deepFreeze({ status: 'insufficient', reason: 'below-threshold', datasetVersion, items: [], totalCharacters: 0, topScore });
      return deepFreeze({ status: 'ready', datasetVersion, items: structuredClone(context.items), totalCharacters: context.totalCharacters, topScore });
    },
  };
}
