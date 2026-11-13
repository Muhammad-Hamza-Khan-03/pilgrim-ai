import type {
  MarkdownKnowledgeStagingRejection,
  MarkdownKnowledgeStagingResult,
  StagedMarkdownChunk,
} from './markdown-knowledge-staging.js';

export type KnowledgeIndexRecord = StagedMarkdownChunk & {
  recordId: string;
};

export type KnowledgeIndexMaterializationRequest = {
  staging: MarkdownKnowledgeStagingResult;
};

export type KnowledgeIndexMaterializationResult = {
  status: 'staging';
  indexed: false;
  datasetVersion: number;
  records: KnowledgeIndexRecord[];
  rejected: MarkdownKnowledgeStagingRejection[];
  sources: string[];
};

const clone = <T>(value: T): T => structuredClone(value);

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function serialized(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? '';
}

function recordCompare(left: KnowledgeIndexRecord, right: KnowledgeIndexRecord): number {
  return compare(left.recordId, right.recordId)
    || compare(left.sourceId, right.sourceId)
    || compare(left.blockId, right.blockId)
    || left.startLine - right.startLine
    || left.endLine - right.endLine
    || left.ordinal - right.ordinal
    || compare(serialized(left), serialized(right));
}

function rejectionCompare(left: MarkdownKnowledgeStagingRejection, right: MarkdownKnowledgeStagingRejection): number {
  return compare(left.sourceId, right.sourceId)
    || compare(left.blockId, right.blockId)
    || compare(left.code, right.code)
    || compare(left.message, right.message);
}

export function materializeKnowledgeIndex(
  { staging }: KnowledgeIndexMaterializationRequest,
): KnowledgeIndexMaterializationResult {
  const records = staging.chunks
    .map((chunk): KnowledgeIndexRecord => ({ ...clone(chunk), recordId: chunk.chunkId }))
    .sort(recordCompare);
  const rejected = clone(staging.rejected).sort(rejectionCompare);
  const sources = Array.from(new Set([
    ...staging.sources,
    ...staging.chunks.map((chunk) => chunk.sourceId),
  ])).sort(compare);

  return clone({
    status: 'staging' as const,
    indexed: false as const,
    datasetVersion: staging.datasetVersion,
    records,
    rejected,
    sources,
  });
}
