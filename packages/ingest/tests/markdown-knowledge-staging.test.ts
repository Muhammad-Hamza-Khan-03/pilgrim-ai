import { describe, expect, it } from 'vitest';
import { stageMarkdownKnowledge, type MarkdownKnowledgeStagingRequest } from '../src/index.js';
import type { MarkdownChunk } from '../src/index.js';

function chunk(overrides: Partial<MarkdownChunk> = {}): MarkdownChunk {
  return {
    chunkId: 'chunk-1',
    sourceId: 'source-b',
    blockId: 'block-2',
    headingPath: ['Guide', 'Topic'],
    text: 'content',
    startLine: 4,
    endLine: 5,
    ordinal: 1,
    ...overrides,
  };
}

function request(chunks: readonly MarkdownChunk[]): MarkdownKnowledgeStagingRequest {
  return { datasetVersion: 7, chunks };
}

describe('Phase 2N deterministic Markdown knowledge staging', () => {
  it('stages chunks with exact lifecycle fields and sorted unique sources', () => {
    const output = stageMarkdownKnowledge(request([
      chunk({ chunkId: 'z', sourceId: 'source-z' }),
      chunk({ chunkId: 'a', sourceId: 'source-a', blockId: 'block-1' }),
      chunk({ chunkId: 'm', sourceId: 'source-z', blockId: 'block-3' }),
    ]));

    expect(output).toEqual({
      status: 'staging',
      datasetVersion: 7,
      indexed: false,
      chunks: [
        { ...chunk({ chunkId: 'a', sourceId: 'source-a', blockId: 'block-1' }), datasetVersion: 7, status: 'staging', indexed: false },
        { ...chunk({ chunkId: 'm', sourceId: 'source-z', blockId: 'block-3' }), datasetVersion: 7, status: 'staging', indexed: false },
        { ...chunk({ chunkId: 'z', sourceId: 'source-z' }), datasetVersion: 7, status: 'staging', indexed: false },
      ],
      rejected: [],
      sources: ['source-a', 'source-z'],
    });
  });

  it('is independent of input order and uses metadata/content tie breakers', () => {
    const first = chunk({ chunkId: 'same', sourceId: 'source-b', blockId: 'block-b', startLine: 3, endLine: 4, text: 'B' });
    const second = chunk({ chunkId: 'same', sourceId: 'source-a', blockId: 'block-z', startLine: 9, endLine: 10, text: 'A' });
    const left = stageMarkdownKnowledge(request([first, second, chunk({ chunkId: 'other', sourceId: 'source-c' })]));
    const right = stageMarkdownKnowledge(request([chunk({ chunkId: 'other', sourceId: 'source-c' }), second, first]));

    expect(left).toEqual(right);
    expect(left.chunks).toHaveLength(1);
    expect(left.chunks.find((entry) => entry.chunkId === 'same')).toBeUndefined();
    expect(left.rejected).toEqual([
      { code: 'CONFLICTING_CHUNK_ID', sourceId: 'source-a', blockId: 'block-z', message: 'conflicting chunks share chunkId same' },
      { code: 'CONFLICTING_CHUNK_ID', sourceId: 'source-b', blockId: 'block-b', message: 'conflicting chunks share chunkId same' },
    ]);
  });

  it('deduplicates identical chunks with one deterministic rejection', () => {
    const duplicate = chunk({ chunkId: 'same', sourceId: 'source-a', blockId: 'block-a' });
    const output = stageMarkdownKnowledge(request([duplicate, structuredClone(duplicate)]));

    expect(output.chunks).toHaveLength(1);
    expect(output.rejected).toEqual([{ code: 'DUPLICATE_CHUNK_ID', sourceId: 'source-a', blockId: 'block-a', message: 'duplicate chunkId same' }]);
  });

  it('rejects every member of a conflicting identity group rather than overwriting', () => {
    const left = chunk({ chunkId: 'same', sourceId: 'source-a', blockId: 'block-a', text: 'left' });
    const right = chunk({ chunkId: 'same', sourceId: 'source-b', blockId: 'block-b', text: 'right' });
    const output = stageMarkdownKnowledge(request([right, left]));

    expect(output.chunks).toEqual([]);
    expect(output.rejected).toEqual([
      { code: 'CONFLICTING_CHUNK_ID', sourceId: 'source-a', blockId: 'block-a', message: 'conflicting chunks share chunkId same' },
      { code: 'CONFLICTING_CHUNK_ID', sourceId: 'source-b', blockId: 'block-b', message: 'conflicting chunks share chunkId same' },
    ]);
  });

  it('accepts empty batches and deeply isolates inputs and outputs', () => {
    const input = chunk();
    const before = structuredClone(input);
    const output = stageMarkdownKnowledge(request([input]));
    output.chunks[0].headingPath.push('mutated');
    output.chunks[0].text = 'mutated';

    expect(input).toEqual(before);
    expect(stageMarkdownKnowledge(request([]))).toEqual({ status: 'staging', datasetVersion: 7, indexed: false, chunks: [], rejected: [], sources: [] });
    expect(input.headingPath).toEqual(before.headingPath);
    expect(input.text).toBe(before.text);
  });
});
