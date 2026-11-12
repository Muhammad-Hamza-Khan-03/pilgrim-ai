import { createHash } from 'node:crypto';
import type { MarkdownBlock, MarkdownDocument } from './markdown-connector.js';

export interface MarkdownChunkOptions {
  maxChars: number;
  overlapChars: number;
}

export interface MarkdownChunk {
  chunkId: string;
  sourceId: string;
  blockId: string;
  headingPath: string[];
  text: string;
  startLine: number;
  endLine: number;
  ordinal: number;
}

export class MarkdownChunkingError extends Error {
  readonly code: 'INVALID_CONFIGURATION';

  constructor(message: string) {
    super(message);
    this.name = 'MarkdownChunkingError';
    this.code = 'INVALID_CONFIGURATION';
  }
}

type Line = { text: string; start: number; end: number; number: number };

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function linesOf(text: string): Line[] {
  const hasTrailingNewline = text.endsWith('\n');
  const raw = text.split('\n');
  if (hasTrailingNewline) raw.pop();
  let offset = 0;
  return raw.map((line, index) => {
    const end = offset + line.length + ((index < raw.length - 1 || hasTrailingNewline) ? 1 : 0);
    const result = { text: line, start: offset, end, number: index };
    offset = end;
    return result;
  });
}

function paragraphEnds(lines: Line[]): number[] {
  const ends: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].text.trim() !== '') continue;
    while (index + 1 < lines.length && lines[index + 1].text.trim() === '') index++;
    ends.push(lines[index].end);
  }
  return ends;
}

function chunkId(chunk: Omit<MarkdownChunk, 'chunkId'>): string {
  const normalized = [
    chunk.sourceId,
    chunk.blockId,
    String(chunk.ordinal),
    String(chunk.startLine),
    String(chunk.endLine),
    chunk.text,
  ].join('\0');
  return `markdown-chunk-${createHash('sha256').update(normalized).digest('hex')}`;
}

function lineRange(lines: Line[], start: number, end: number): { startLine: number; endLine: number } {
  const overlapping = lines.filter((line) => line.end > start && line.start < end);
  const first = overlapping[0] ?? lines[0];
  const last = overlapping[overlapping.length - 1] ?? first;
  return { startLine: first.number, endLine: last.number };
}

function chunkBlock(sourceId: string, block: MarkdownBlock, options: MarkdownChunkOptions): MarkdownChunk[] {
  const text = normalize(block.text);
  if (text.length === 0 || text.trim().length === 0) return [];
  const lines = linesOf(text);
  const lineEnds = lines.map((line) => line.end).filter((end) => end > 0);
  const paragraphBoundary = new Set(paragraphEnds(lines));
  const result: MarkdownChunk[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = cursor;
    const limit = Math.min(text.length, start + options.maxChars);
    const paragraphEnd = Array.from(paragraphBoundary).filter((end) => end > cursor && end <= limit).sort((a, b) => b - a)[0];
    const lineEnd = lineEnds.filter((end) => end > cursor && end <= limit).sort((a, b) => b - a)[0];
    const end = paragraphEnd ?? lineEnd ?? limit;
    if (end <= cursor) throw new Error('Markdown chunker failed to make progress');
    const chunkText = text.slice(start, end);
    if (chunkText.length > 0 && chunkText.trim().length > 0) {
      const range = lineRange(lines, start, end);
      const base = {
        sourceId,
        blockId: block.blockId,
        headingPath: [...block.headingPath],
        text: chunkText,
        startLine: block.startLine + range.startLine,
        endLine: block.startLine + range.endLine,
        ordinal: result.length,
      };
      if (result.length === 0 || result[result.length - 1].text !== base.text || result[result.length - 1].startLine !== base.startLine || result[result.length - 1].endLine !== base.endLine) {
        result.push({ ...base, chunkId: chunkId(base) });
      }
    }
    cursor = end === text.length ? end : Math.max(cursor + 1, end - options.overlapChars);
  }
  return result;
}

export function chunkMarkdownDocument(document: MarkdownDocument, options: MarkdownChunkOptions): MarkdownChunk[] {
  if (!Number.isInteger(options.maxChars) || options.maxChars < 1) throw new MarkdownChunkingError('maxChars must be an integer greater than or equal to 1');
  if (!Number.isInteger(options.overlapChars) || options.overlapChars < 0) throw new MarkdownChunkingError('overlapChars must be a non-negative integer');
  if (options.overlapChars >= options.maxChars) throw new MarkdownChunkingError('overlapChars must be less than maxChars');
  const chunks: MarkdownChunk[] = [];
  for (const block of document.blocks) chunks.push(...chunkBlock(document.source, block, options));
  return chunks.map((chunk, ordinal) => {
    const withOrdinal = { ...chunk, ordinal };
    return { ...withOrdinal, chunkId: chunkId(withOrdinal) };
  });
}
