import { createHash } from 'node:crypto';
import type { MarkdownBlock, MarkdownDocument } from './markdown-connector.js';

export type { MarkdownDocument } from './markdown-connector.js';

export type MarkdownTableAlignment = 'left' | 'center' | 'right' | 'none';

export interface MarkdownTableRow {
  rowNumber: number;
  values: string[];
}

export interface MarkdownTable {
  tableId: string;
  sourceId: string;
  blockId: string;
  headingPath: string[];
  headers: string[];
  alignments: MarkdownTableAlignment[];
  rows: MarkdownTableRow[];
  startLine: number;
  endLine: number;
  headerRowNumber: number;
}

type Line = { text: string; number: number };

type Candidate = {
  headers: string[];
  alignments: MarkdownTableAlignment[];
  rows: MarkdownTableRow[];
  startLine: number;
  endLine: number;
  headerRowNumber: number;
};

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function linesOf(text: string): Line[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, number) => ({ text: line, number }));
}

function fenceStart(line: string): { character: '`' | '~'; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return match ? { character: match[1][0] as '`' | '~', length: match[1].length } : undefined;
}

function fenceClose(line: string, fence: { character: '`' | '~'; length: number }): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match !== null && match[1][0] === fence.character && match[1].length >= fence.length;
}

function splitRow(line: string): string[] | undefined {
  if (!line.includes('|')) return undefined;
  const cells: string[] = [];
  let cell = '';
  let hasPipe = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '\\' && line[index + 1] === '|') {
      cell += '|';
      index++;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
      hasPipe = true;
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  const trimmed = line.trim();
  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|') && cells.length > 0) cells.pop();
  return hasPipe ? cells : undefined;
}

function delimiterAlignment(cell: string): MarkdownTableAlignment | undefined {
  const trimmed = cell.trim();
  if (!/^:?-{3,}:?$/.test(trimmed)) return undefined;
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  return left && right ? 'center' : left ? 'left' : right ? 'right' : 'none';
}

function tableId(sourceId: string, blockId: string, candidate: Candidate, ordinal: number): string {
  const content = JSON.stringify({ sourceId, blockId, ordinal, ...candidate });
  return `markdown-table-${createHash('sha256').update(content).digest('hex')}`;
}

function candidateAt(lines: Line[], index: number, block: MarkdownBlock): Candidate | undefined {
  const headers = splitRow(lines[index].text);
  const delimiters = splitRow(lines[index + 1]?.text ?? '');
  if (!headers || !delimiters || headers.length !== delimiters.length || headers.length === 0) return undefined;
  const alignments = delimiters.map(delimiterAlignment);
  if (alignments.some((alignment) => alignment === undefined)) return undefined;

  const rows: MarkdownTableRow[] = [];
  let end = index + 1;
  for (let cursor = index + 2; cursor < lines.length; cursor++) {
    const text = lines[cursor].text;
    if (text.trim() === '') break;
    const values = splitRow(text);
    if (!values) break;
    if (values.length !== headers.length) return undefined;
    rows.push({ rowNumber: block.startLine + lines[cursor].number, values });
    end = cursor;
  }
  return {
    headers,
    alignments: alignments as MarkdownTableAlignment[],
    rows,
    startLine: block.startLine + lines[index].number,
    endLine: block.startLine + lines[end].number,
    headerRowNumber: block.startLine + lines[index].number,
  };
}

function extractBlock(block: MarkdownBlock): Candidate[] {
  const lines = linesOf(normalize(block.text));
  const candidates: Candidate[] = [];
  let fence: { character: '`' | '~'; length: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].text;
    const marker = fenceStart(line);
    if (marker && !fence) { fence = marker; continue; }
    if (fence) {
      if (fenceClose(line, fence)) fence = undefined;
      continue;
    }
    if (index + 1 >= lines.length) continue;
    const candidate = candidateAt(lines, index, block);
    if (candidate) {
      candidates.push(candidate);
      index = candidate.endLine - block.startLine - lines[0].number;
    }
  }
  return candidates;
}

export function extractMarkdownTables(document: MarkdownDocument): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  for (const block of document.blocks) {
    for (const candidate of extractBlock(block)) {
      const ordinal = tables.length;
      tables.push({
        tableId: tableId(document.source, block.blockId, candidate, ordinal),
        sourceId: document.source,
        blockId: block.blockId,
        headingPath: [...block.headingPath],
        headers: [...candidate.headers],
        alignments: [...candidate.alignments],
        rows: candidate.rows.map((row) => ({ rowNumber: row.rowNumber, values: [...row.values] })),
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        headerRowNumber: candidate.headerRowNumber,
      });
    }
  }
  return tables;
}
