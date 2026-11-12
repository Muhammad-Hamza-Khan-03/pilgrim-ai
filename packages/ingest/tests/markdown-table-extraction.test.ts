import { describe, expect, it } from 'vitest';
import { extractMarkdownTables, type MarkdownDocument } from '../src/index.js';

const document: MarkdownDocument = {
  source: 'source-1',
  text: '# Guide\n\n| Name | Notes |\n| :--- | ---: |\n| Alpha | escaped \\| pipe |\n| Beta | plain |\n\nprose | not a table\n\n```md\n| Code | Value |\n| --- | --- |\n| ignored | ignored |\n```\n\n## Next\n\nA | B\n--- | ---\nC | D\n',
  blocks: [
    {
      blockId: 'block-guide',
      headingPath: ['Guide'],
      text: '\n| Name | Notes |\n| :--- | ---: |\n| Alpha | escaped \\| pipe |\n| Beta | plain |\n\nprose | not a table\n\n```md\n| Code | Value |\n| --- | --- |\n| ignored | ignored |\n```\n\n',
      startLine: 2,
      endLine: 16,
    },
    {
      blockId: 'block-next',
      headingPath: ['Next'],
      text: '\nA | B\n--- | ---\nC | D\n',
      startLine: 18,
      endLine: 21,
    },
  ],
};

describe('deterministic raw Markdown table extraction', () => {
  it('extracts GFM tables with alignment, escaped pipes, provenance, and row numbers', () => {
    const tables = extractMarkdownTables(document);

    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({
      sourceId: 'source-1',
      blockId: 'block-guide',
      headingPath: ['Guide'],
      headers: ['Name', 'Notes'],
      alignments: ['left', 'right'],
      startLine: 3,
      endLine: 6,
      headerRowNumber: 3,
    });
    expect(tables[0].rows).toEqual([
      { rowNumber: 5, values: ['Alpha', 'escaped | pipe'] },
      { rowNumber: 6, values: ['Beta', 'plain'] },
    ]);
    expect(tables[1]).toMatchObject({
      blockId: 'block-next',
      headingPath: ['Next'],
      headers: ['A', 'B'],
      alignments: ['none', 'none'],
      startLine: 19,
      endLine: 21,
      headerRowNumber: 19,
    });
  });

  it('accepts optional leading and trailing pipes and preserves empty strings', () => {
    const input: MarkdownDocument = {
      source: 'source-2',
      text: '| A | B |\n| --- | --- |\n|  | value  |\n\nleft | right\n--- | ---\n |  |  |',
      blocks: [{ blockId: 'block-1', headingPath: [], text: '| A | B |\n| --- | --- |\n|  | value  |\n\nleft | right\n--- | ---\n |  |  |', startLine: 1, endLine: 7 }],
    };
    const tables = extractMarkdownTables(input);
    expect(tables).toHaveLength(2);
    expect(tables[0].rows).toEqual([{ rowNumber: 3, values: ['', 'value'] }]);
    expect(tables[1].rows).toEqual([{ rowNumber: 7, values: ['', ''] }]);
  });

  it('ignores prose, fenced code, malformed candidates, and inconsistent rows', () => {
    const input: MarkdownDocument = {
      source: 'source-3',
      text: 'prose | prose\nnot a delimiter\n\n| Missing | delimiter |\n|\n\n| Good | table |\n| --- | --- |\n| one | two | three\n\n~~~\n| fenced | table |\n| --- | --- |\n~~~\n',
      blocks: [{ blockId: 'block-1', headingPath: [], text: 'prose | prose\nnot a delimiter\n\n| Missing | delimiter |\n|\n\n| Good | table |\n| --- | --- |\n| one | two | three\n\n~~~\n| fenced | table |\n| --- | --- |\n~~~\n', startLine: 1, endLine: 17 }],
    };
    expect(extractMarkdownTables(input)).toEqual([]);
  });

  it('is deterministic, normalizes CRLF, and does not mutate the document', () => {
    const before = structuredClone(document);
    const lf = extractMarkdownTables(document);
    const crlf = extractMarkdownTables({
      ...document,
      text: document.text.replaceAll('\n', '\r\n'),
      blocks: document.blocks.map((block) => ({ ...block, text: block.text.replaceAll('\n', '\r\n') })),
    });
    expect(crlf).toEqual(lf);
    expect(extractMarkdownTables(document)).toEqual(lf);
    expect(document).toEqual(before);
    expect(new Set(lf.map((table) => table.tableId)).size).toBe(lf.length);
  });
});
