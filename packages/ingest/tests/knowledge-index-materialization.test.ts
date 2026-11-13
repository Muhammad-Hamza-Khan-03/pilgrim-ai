import { describe, expect, it } from 'vitest';
import {
  materializeKnowledgeIndex,
  type KnowledgeIndexRecord,
} from '../src/index.js';
import type {
  MarkdownKnowledgeStagingResult,
  StagedMarkdownChunk,
} from '../src/index.js';

function chunk(overrides: Partial<StagedMarkdownChunk> = {}): StagedMarkdownChunk {
  return {
    chunkId: 'chunk-1',
    sourceId: 'source-b',
    blockId: 'block-2',
    headingPath: ['Guide', 'Topic'],
    text: 'content',
    startLine: 4,
    endLine: 5,
    ordinal: 1,
    datasetVersion: 7,
    status: 'staging',
    indexed: false,
    ...overrides,
  };
}

function staging(overrides: Partial<MarkdownKnowledgeStagingResult> = {}): MarkdownKnowledgeStagingResult {
  return {
    status: 'staging',
    datasetVersion: 7,
    indexed: false,
    chunks: [],
    rejected: [],
    sources: [],
    ...overrides,
  };
}

describe('Phase 2O knowledge-index materialization', () => {
  it('materializes accepted chunks as records with the exact chunk identity and lifecycle fields', () => {
    const output = materializeKnowledgeIndex({
      staging: staging({ chunks: [chunk({ chunkId: 'chunk-2' }), chunk({ chunkId: 'chunk-1', sourceId: 'source-a' })] }),
    });

    expect(output).toEqual({
      status: 'staging',
      indexed: false,
      datasetVersion: 7,
      records: [
        { ...chunk({ chunkId: 'chunk-1', sourceId: 'source-a' }), recordId: 'chunk-1' },
        { ...chunk({ chunkId: 'chunk-2' }), recordId: 'chunk-2' },
      ],
      rejected: [],
      sources: ['source-a', 'source-b'],
    });
    expect(output.records.every((record) => record.recordId === record.chunkId)).toBe(true);
  });

  it('sorts records independently of input order using all deterministic tie breakers', () => {
    const first = chunk({ chunkId: 'same', sourceId: 'source-b', blockId: 'block-b', startLine: 3, endLine: 4, ordinal: 2, text: 'B' });
    const second = chunk({ chunkId: 'same', sourceId: 'source-a', blockId: 'block-z', startLine: 9, endLine: 10, ordinal: 1, text: 'A' });
    const left = materializeKnowledgeIndex({ staging: staging({ chunks: [first, second] }) });
    const right = materializeKnowledgeIndex({ staging: staging({ chunks: [second, first] }) });

    expect(left).toEqual(right);
    expect(left.records.map((record) => record.sourceId)).toEqual(['source-a', 'source-b']);
  });

  it('propagates sorted rejection diagnostics without filtering or rewriting them', () => {
    const rejected = [
      { code: 'DUPLICATE_CHUNK_ID' as const, sourceId: 'source-z', blockId: 'block-z', message: 'duplicate z' },
      { code: 'CONFLICTING_CHUNK_ID' as const, sourceId: 'source-a', blockId: 'block-a', message: 'conflict a' },
    ];
    const output = materializeKnowledgeIndex({ staging: staging({ rejected, sources: ['source-z', 'source-a'] }) });

    expect(output.rejected).toEqual([rejected[1], rejected[0]]);
    expect(output.sources).toEqual(['source-a', 'source-z']);
  });

  it('derives sorted unique sources from staging chunks and preserves empty input', () => {
    expect(materializeKnowledgeIndex({ staging: staging() })).toEqual({
      status: 'staging', indexed: false, datasetVersion: 7, records: [], rejected: [], sources: [],
    });
    expect(materializeKnowledgeIndex({ staging: staging({ chunks: [chunk({ sourceId: 'z' }), chunk({ sourceId: 'a' }), chunk({ sourceId: 'z' })] }) }).sources)
      .toEqual(['a', 'z']);
  });

  it('deeply clones staging input and output records and diagnostics', () => {
    const input = staging({
      chunks: [chunk()],
      rejected: [{ code: 'DUPLICATE_CHUNK_ID', sourceId: 'source-x', blockId: 'block-x', message: 'duplicate' }],
      sources: ['source-x'],
    });
    const before = structuredClone(input);
    const output = materializeKnowledgeIndex({ staging: input });
    output.records[0].headingPath.push('mutated');
    output.records[0].text = 'mutated';
    output.rejected[0].message = 'mutated';
    output.sources.push('mutated');

    expect(input).toEqual(before);
    expect(output.records[0]).toEqual(expect.objectContaining<KnowledgeIndexRecord>({ recordId: 'chunk-1', chunkId: 'chunk-1' }));
  });
});
