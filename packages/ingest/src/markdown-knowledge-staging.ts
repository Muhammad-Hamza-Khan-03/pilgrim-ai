import type { MarkdownChunk } from './markdown-chunking.js';

export type MarkdownKnowledgeStagingRequest = {
  datasetVersion: number;
  chunks: readonly MarkdownChunk[];
};

export type StagedMarkdownChunk = MarkdownChunk & {
  datasetVersion: number;
  status: 'staging';
  indexed: false;
};

export type MarkdownKnowledgeStagingRejectionCode = 'DUPLICATE_CHUNK_ID' | 'CONFLICTING_CHUNK_ID';

export type MarkdownKnowledgeStagingRejection = {
  code: MarkdownKnowledgeStagingRejectionCode;
  sourceId: string;
  blockId: string;
  message: string;
};

export type MarkdownKnowledgeStagingResult = {
  status: 'staging';
  datasetVersion: number;
  indexed: false;
  chunks: StagedMarkdownChunk[];
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

function chunkCompare(left: MarkdownChunk, right: MarkdownChunk): number {
  return compare(left.chunkId, right.chunkId)
    || compare(left.sourceId, right.sourceId)
    || compare(left.blockId, right.blockId)
    || left.startLine - right.startLine
    || left.endLine - right.endLine
    || left.ordinal - right.ordinal
    || compare(serialized(left.headingPath), serialized(right.headingPath))
    || compare(serialized(left), serialized(right));
}

function rejectionCompare(left: MarkdownKnowledgeStagingRejection, right: MarkdownKnowledgeStagingRejection): number {
  return compare(left.sourceId, right.sourceId)
    || compare(left.blockId, right.blockId)
    || compare(left.code, right.code)
    || compare(left.message, right.message);
}

export function stageMarkdownKnowledge(request: MarkdownKnowledgeStagingRequest): MarkdownKnowledgeStagingResult {
  const chunks = request.chunks.map(clone).sort(chunkCompare);
  const staged: StagedMarkdownChunk[] = [];
  const rejected: MarkdownKnowledgeStagingRejection[] = [];

  for (let index = 0; index < chunks.length;) {
    const chunkId = chunks[index].chunkId;
    const group: MarkdownChunk[] = [];
    while (index < chunks.length && chunks[index].chunkId === chunkId) group.push(chunks[index++]);

    const content = serialized(group[0]);
    const identical = group.every((chunk) => serialized(chunk) === content);
    if (!identical) {
      for (const chunk of group) rejected.push({
        code: 'CONFLICTING_CHUNK_ID',
        sourceId: chunk.sourceId,
        blockId: chunk.blockId,
        message: `conflicting chunks share chunkId ${chunkId}`,
      });
      continue;
    }

    staged.push({ ...clone(group[0]), datasetVersion: request.datasetVersion, status: 'staging', indexed: false });
    for (const chunk of group.slice(1)) rejected.push({
      code: 'DUPLICATE_CHUNK_ID',
      sourceId: chunk.sourceId,
      blockId: chunk.blockId,
      message: `duplicate chunkId ${chunkId}`,
    });
  }

  const sources = Array.from(new Set(chunks.map((chunk) => chunk.sourceId))).sort(compare);
  return {
    status: 'staging',
    datasetVersion: request.datasetVersion,
    indexed: false,
    chunks: clone(staged),
    rejected: clone(rejected.sort(rejectionCompare)),
    sources,
  };
}
