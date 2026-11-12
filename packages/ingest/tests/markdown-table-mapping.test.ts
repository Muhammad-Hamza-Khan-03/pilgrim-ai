import { describe, expect, it } from 'vitest';
import { generateCatalogSchema } from '../../catalog-schema/src/index.js';
import type { Pack } from '../../engine/src/index.js';
import { classifyMarkdownTable, type MarkdownTable } from '../src/index.js';

const pack = {
  pack: 'cars', version: 1,
  locale: { default: 'en', supported: ['en'] },
  persona: { tone: 'plain', currency: 'USD' },
  catalog: {
    car: { attributes: { name: { type: 'text' }, daily_rate: { type: 'money' } } },
    van: { attributes: { name: { type: 'text' }, daily_rate: { type: 'money' } } },
  },
  slots: { days: { type: 'int' } }, rules: [], bundle: { pick: 'car' },
  objectives: { price: { direction: 'min', weight: 1 } }, results: { count: 1, diversity: 0 },
} as unknown as Pack;
const schema = generateCatalogSchema(pack);
const singlePack = { ...pack, catalog: { car: pack.catalog.car } } as Pack;
const singleSchema = generateCatalogSchema(singlePack);

function table(headers: string[], rows: string[][] = [['C-1', 'Sedan', '12']]): MarkdownTable {
  return {
    tableId: 'markdown-table-1', sourceId: 'source-1', blockId: 'block-1', headingPath: ['Cars'],
    headers, alignments: headers.map(() => 'none'),
    rows: rows.map((values, index) => ({ rowNumber: index + 8, values })),
    startLine: 5, endLine: 8, headerRowNumber: 5,
  };
}

describe('deterministic Markdown table classification and schema mapping', () => {
  it('maps normalized headers and preserves string row values, order, and Phase 2J provenance', () => {
    const result = classifyMarkdownTable({
      table: table(['ID', ' Name ', 'Daily  Rate']), pack: singlePack, schema: singleSchema,
    });
    expect(result).toEqual({
      status: 'mapped', entity: 'car',
      headers: [
        { source: 'ID', normalized: 'id', attribute: 'id' },
        { source: ' Name ', normalized: 'name', attribute: 'name' },
        { source: 'Daily  Rate', normalized: 'daily_rate', attribute: 'daily_rate' },
      ],
      rows: [{ order: 0, rowNumber: 8, values: { id: 'C-1', name: 'Sedan', daily_rate: '12' } }],
      provenance: {
        tableId: 'markdown-table-1', sourceId: 'source-1', blockId: 'block-1', headingPath: ['Cars'],
        startLine: 5, endLine: 8, headerRowNumber: 5,
      },
    });
  });

  it('uses only explicit request aliases and rejects unknown or duplicate normalized headers without partial mapping', () => {
    const aliased = classifyMarkdownTable({ table: table(['ID', 'Vehicle Name', 'Rate']), pack: singlePack, schema: singleSchema, aliases: { car: { 'Vehicle Name': 'name', Rate: 'daily_rate' } } });
    expect(aliased.status).toBe('mapped');
    expect(aliased.status === 'mapped' && aliased.headers.map((header) => header.attribute)).toEqual(['id', 'name', 'daily_rate']);

    const unknown = classifyMarkdownTable({ table: table(['ID', 'Name', 'Price']), pack: singlePack, schema: singleSchema });
    expect(unknown.status).toBe('needs_review');
    expect(unknown.status === 'needs_review' && unknown.reasons.map((reason) => reason.code)).toContain('UNKNOWN_HEADER');
    expect(unknown.status === 'needs_review' && unknown.reasons.flatMap((reason) => reason.unknown ?? [])).toEqual(['price']);

    const collision = classifyMarkdownTable({ table: table(['ID', 'Daily Rate', 'daily-rate']), pack: singlePack, schema: singleSchema });
    expect(collision.status).toBe('needs_review');
    expect(collision.status === 'needs_review' && collision.reasons.map((reason) => reason.code)).toEqual(['NORMALIZED_HEADER_COLLISION']);
  });

  it('reports no match, ambiguity, missing semantic headers, and child parent-context requirements', () => {
    const noMatch = classifyMarkdownTable({ table: table(['ID', 'Color']), pack, schema });
    expect(noMatch.status).toBe('needs_review');
    expect(noMatch.status === 'needs_review' && noMatch.reasons.map((reason) => reason.code)).toEqual(['NO_ENTITY_MATCH', 'UNKNOWN_HEADER']);

    const ambiguous = classifyMarkdownTable({ table: table(['ID', 'Name']), pack, schema });
    expect(ambiguous.status).toBe('needs_review');
    expect(ambiguous.status === 'needs_review' && ambiguous.reasons[0]).toMatchObject({ code: 'AMBIGUOUS_ENTITY', candidates: ['car', 'van'] });

    const generatedOnly = classifyMarkdownTable({ table: table(['ID', 'Dataset Version']), pack, schema });
    expect(generatedOnly.status).toBe('needs_review');
    expect(generatedOnly.status === 'needs_review' && generatedOnly.reasons.map((reason) => reason.code)).toContain('MISSING_SEMANTIC_HEADER');

    const childPack = { ...pack, catalog: { parent: { attributes: { name: 'text' }, children: 'child' }, child: { attributes: { label: 'text' } } } } as Pack;
    const childSchema = generateCatalogSchema(childPack);
    const child = classifyMarkdownTable({ table: table(['ID', 'Label']), pack: childPack, schema: childSchema });
    expect(child.status).toBe('needs_review');
    expect(child.status === 'needs_review' && child.reasons.map((reason) => reason.code)).toContain('PARENT_CONTEXT_REQUIRED');
  });

  it('rejects inconsistent row widths and is immutable and repeatably deterministic', () => {
    const input = table(['ID', 'Name'], [['1', 'one']]);
    const before = structuredClone(input);
    input.rows.push({ rowNumber: 9, values: ['2'] });
    const first = classifyMarkdownTable({ table: input, pack: singlePack, schema: singleSchema });
    const second = classifyMarkdownTable({ table: input, pack: singlePack, schema: singleSchema });
    expect(first).toEqual(second);
    expect(first.status).toBe('needs_review');
    expect(first.status === 'needs_review' && first.reasons.map((reason) => reason.code)).toContain('ROW_WIDTH_MISMATCH');
    expect(input).toEqual({ ...before, rows: [...before.rows, { rowNumber: 9, values: ['2'] }] });
  });
});
