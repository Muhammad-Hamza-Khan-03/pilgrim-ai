import type {
  KnowledgeKeywordRetriever,
  KnowledgeKeywordSearchRequest,
  KnowledgeRetrievalHit,
  KnowledgeRetrievalProvenance,
  KnowledgeRetrievalRecord,
  KnowledgeRetrievalResult,
  KnowledgeVectorRetriever,
  KnowledgeVectorSearchRequest,
} from './knowledge-retrieval.js';

export const MAX_KNOWLEDGE_RETRIEVAL_LIMIT = 100;

export type KnowledgeRetrievalErrorCode = 'INVALID_REQUEST' | 'INVALID_RECORD' | 'DUPLICATE_RECORD_ID';

export class KnowledgeRetrievalError extends Error {
  readonly code: KnowledgeRetrievalErrorCode;
  constructor(code: KnowledgeRetrievalErrorCode, message: string) {
    super(message);
    this.name = 'KnowledgeRetrievalError';
    this.code = code;
  }
}

type Options = Readonly<{ available?: boolean }>;
const clone = <T>(value: T): T => structuredClone(value);
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}
function serialized(value: unknown): string { return JSON.stringify(canonical(value)) ?? ''; }

function validateVersionAndLimit(datasetVersion: number, limit: number): void {
  if (!Number.isSafeInteger(datasetVersion) || datasetVersion < 0) throw new KnowledgeRetrievalError('INVALID_REQUEST', 'datasetVersion must be a nonnegative safe integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_KNOWLEDGE_RETRIEVAL_LIMIT) throw new KnowledgeRetrievalError('INVALID_REQUEST', `limit must be an integer from 1 to ${MAX_KNOWLEDGE_RETRIEVAL_LIMIT}`);
}
function validateProvenance(provenance: KnowledgeRetrievalProvenance): void {
  if (!provenance || typeof provenance !== 'object' || !Number.isSafeInteger(provenance.datasetVersion) || provenance.datasetVersion < 0
    || typeof provenance.sourceId !== 'string' || typeof provenance.chunkId !== 'string' || typeof provenance.blockId !== 'string'
    || !Number.isSafeInteger(provenance.startLine) || !Number.isSafeInteger(provenance.endLine)
    || provenance.startLine < 1 || provenance.endLine < provenance.startLine) {
    throw new KnowledgeRetrievalError('INVALID_RECORD', 'record provenance is malformed');
  }
}
function validateRecords(records: readonly KnowledgeRetrievalRecord[]): readonly KnowledgeRetrievalRecord[] {
  const cloned = clone(records);
  const seen = new Set<string>();
  for (const record of cloned) {
    if (!record || typeof record.recordId !== 'string' || record.recordId.length === 0) throw new KnowledgeRetrievalError('INVALID_RECORD', 'recordId must be a non-empty string');
    validateProvenance(record.provenance);
    const key = `${record.provenance.datasetVersion}\u0000${record.recordId}`;
    if (seen.has(key)) throw new KnowledgeRetrievalError('DUPLICATE_RECORD_ID', `duplicate recordId ${record.recordId} in dataset ${record.provenance.datasetVersion}`);
    seen.add(key);
  }
  return cloned;
}
function available(datasetVersion: number, results: KnowledgeRetrievalHit[]): KnowledgeRetrievalResult {
  return { status: 'available', datasetVersion, results: clone(results) };
}
function unavailable(): KnowledgeRetrievalResult {
  return { status: 'unavailable', reason: 'index-unavailable', results: [] };
}
function hit(record: KnowledgeRetrievalRecord, score: number): KnowledgeRetrievalHit {
  const output: KnowledgeRetrievalHit = { recordId: record.recordId, score, provenance: clone(record.provenance), ...(record.text === undefined ? {} : { text: record.text }) };
  return output;
}
function order(left: KnowledgeRetrievalHit, right: KnowledgeRetrievalHit): number {
  return right.score - left.score
    || compare(left.recordId, right.recordId)
    || compare(left.provenance.sourceId, right.provenance.sourceId)
    || compare(left.provenance.blockId, right.provenance.blockId)
    || left.provenance.startLine - right.provenance.startLine
    || left.provenance.endLine - right.provenance.endLine
    || compare(left.provenance.chunkId, right.provenance.chunkId)
    || compare(serialized(left.provenance), serialized(right.provenance));
}
function versioned(records: readonly KnowledgeRetrievalRecord[], datasetVersion: number): readonly KnowledgeRetrievalRecord[] {
  return records.filter((record) => record.provenance.datasetVersion === datasetVersion);
}

function tokenize(value: string): string[] { return value.toLowerCase().trim().split(/\s+/).filter(Boolean); }

class InMemoryKeywordKnowledgeRetriever implements KnowledgeKeywordRetriever {
  private readonly records: readonly KnowledgeRetrievalRecord[];
  private readonly isAvailable: boolean;
  constructor(records: readonly KnowledgeRetrievalRecord[], options: Options = {}) { this.records = validateRecords(records); this.isAvailable = options.available ?? true; }
  search(request: KnowledgeKeywordSearchRequest): KnowledgeRetrievalResult {
    if (!request || typeof request !== 'object') throw new KnowledgeRetrievalError('INVALID_REQUEST', 'request must be an object');
    validateVersionAndLimit(request.datasetVersion, request.limit);
    if (typeof request.query !== 'string') throw new KnowledgeRetrievalError('INVALID_REQUEST', 'query must be a string');
    if (!this.isAvailable) return unavailable();
    const terms = tokenize(request.query);
    if (terms.length === 0) return available(request.datasetVersion, []);
    const results = versioned(this.records, request.datasetVersion).flatMap((record) => {
      if (record.text === undefined) return [];
      const words = tokenize(record.text);
      const score = terms.reduce((total, term) => total + words.filter((word) => word === term).length, 0);
      return score > 0 ? [hit(record, score)] : [];
    }).sort(order).slice(0, request.limit);
    return available(request.datasetVersion, results);
  }
}

class InMemoryVectorKnowledgeRetriever implements KnowledgeVectorRetriever {
  private readonly records: readonly KnowledgeRetrievalRecord[];
  private readonly dimension: number;
  private readonly isAvailable: boolean;
  constructor(records: readonly KnowledgeRetrievalRecord[], options: Options = {}) {
    this.records = validateRecords(records);
    const dimensions = new Set<number>();
    for (const record of this.records) {
      if (!record.vector || !Array.isArray(record.vector) || record.vector.some((value) => !Number.isFinite(value))) throw new KnowledgeRetrievalError('INVALID_RECORD', 'vector values must be finite');
      dimensions.add(record.vector.length);
    }
    if (dimensions.size > 1) throw new KnowledgeRetrievalError('INVALID_RECORD', 'records must use one vector dimension');
    this.dimension = dimensions.values().next().value ?? 0;
    this.isAvailable = options.available ?? true;
  }
  search(request: KnowledgeVectorSearchRequest): KnowledgeRetrievalResult {
    if (!request || typeof request !== 'object') throw new KnowledgeRetrievalError('INVALID_REQUEST', 'request must be an object');
    validateVersionAndLimit(request.datasetVersion, request.limit);
    if (!Array.isArray(request.query) || request.query.some((value) => !Number.isFinite(value)) || request.query.length !== this.dimension) throw new KnowledgeRetrievalError('INVALID_REQUEST', 'query vector must be finite and match the index dimension');
    if (!this.isAvailable) return unavailable();
    const queryNorm = Math.sqrt(request.query.reduce((sum, value) => sum + value * value, 0));
    const results = versioned(this.records, request.datasetVersion).map((record) => {
      const vector = record.vector!;
      const recordNorm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      const dot = vector.reduce((sum, value, index) => sum + value * request.query[index], 0);
      const score = queryNorm === 0 || recordNorm === 0 ? 0 : dot / (queryNorm * recordNorm);
      return hit(record, score);
    }).sort(order).slice(0, request.limit);
    return available(request.datasetVersion, results);
  }
}

export function createInMemoryKeywordKnowledgeRetriever(records: readonly KnowledgeRetrievalRecord[], options?: Options): KnowledgeKeywordRetriever {
  return new InMemoryKeywordKnowledgeRetriever(records, options);
}
export function createInMemoryVectorKnowledgeRetriever(records: readonly KnowledgeRetrievalRecord[], options?: Options): KnowledgeVectorRetriever {
  return new InMemoryVectorKnowledgeRetriever(records, options);
}
