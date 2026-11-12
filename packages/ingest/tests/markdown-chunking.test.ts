import { describe, expect, it } from 'vitest';
import {
  MarkdownChunkingError,
  chunkMarkdownDocument,
  type MarkdownDocument,
} from '../src/index.js';

const document: MarkdownDocument = {
  source: 'source-1',
  text: '# Guide\nalpha\nbeta\n\nparagraph two\nlast',
  blocks: [
    { blockId: 'block-1', headingPath: ['Guide'], text: 'alpha\nbeta\n\nparagraph two\nlast', startLine: 2, endLine: 6 },
  ],
};

describe('deterministic Markdown chunking', () => {
  it('uses paragraph boundaries before line boundaries and exposes provenance', () => {
    const chunks = chunkMarkdownDocument(document, { maxChars: 18, overlapChars: 0 });
    expect(chunks.map(({ text }) => text)).toEqual(['alpha\nbeta\n\n', 'paragraph two\nlast']);
    expect(chunks.map(({ startLine, endLine, ordinal }) => ({ startLine, endLine, ordinal }))).toEqual([
      { startLine: 2, endLine: 4, ordinal: 0 },
      { startLine: 5, endLine: 6, ordinal: 1 },
    ]);
    expect(chunks.every((chunk) => chunk.sourceId === 'source-1' && chunk.blockId === 'block-1' && chunk.headingPath.join('/') === 'Guide')).toBe(true);
  });

  it('falls back to line boundaries and hard-splits only an oversized line', () => {
    const chunks = chunkMarkdownDocument({ ...document, blocks: [{ ...document.blocks[0], text: '123456789\nshort' }] }, { maxChars: 5, overlapChars: 0 });
    expect(chunks.map(({ text }) => text)).toEqual(['12345', '6789\n', 'short']);
    expect(chunks[0].startLine).toBe(2);
    expect(chunks[0].endLine).toBe(2);
    expect(chunks[1].startLine).toBe(2);
  });

  it('applies bounded character overlap without duplicate chunks', () => {
    const chunks = chunkMarkdownDocument({ ...document, blocks: [{ ...document.blocks[0], text: 'abcdefghij' }] }, { maxChars: 5, overlapChars: 2 });
    expect(chunks.map(({ text }) => text)).toEqual(['abcde', 'defgh', 'ghij']);
    expect(new Set(chunks.map(({ text }) => text)).size).toBe(chunks.length);
  });

  it('is deterministic across equivalent line endings and does not mutate input', () => {
    const input: MarkdownDocument = { ...document, blocks: [{ ...document.blocks[0], text: 'one\r\ntwo\r\n\r\nthree' }] };
    const before = structuredClone(input);
    const lf = chunkMarkdownDocument({ ...input, text: input.text.replaceAll('\r\n', '\n'), blocks: [{ ...input.blocks[0], text: input.blocks[0].text.replaceAll('\r\n', '\n') }] }, { maxChars: 8, overlapChars: 1 });
    const mixed = chunkMarkdownDocument(input, { maxChars: 8, overlapChars: 1 });
    expect(mixed).toEqual(lf);
    expect(input).toEqual(before);
    expect(chunkMarkdownDocument(input, { maxChars: 8, overlapChars: 1 })).toEqual(mixed);
  });

  it('rejects invalid configuration with typed errors', () => {
    for (const options of [
      { maxChars: 0, overlapChars: 0 },
      { maxChars: 5, overlapChars: -1 },
      { maxChars: 5, overlapChars: 5 },
      { maxChars: 5, overlapChars: 6 },
    ]) {
      expect(() => chunkMarkdownDocument(document, options)).toThrowError(MarkdownChunkingError);
      expect(() => chunkMarkdownDocument(document, options)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    }
  });
});
