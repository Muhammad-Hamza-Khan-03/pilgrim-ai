import { describe, expect, it } from 'vitest';
import { generateCatalogSchema } from '../../catalog-schema/src/index.js';
import type { Pack } from '../../engine/src/index.js';
import { materializeMarkdownRows, type MarkdownRowMaterializationRequest } from '../src/index.js';
import type { MappedMarkdownTable } from '../src/markdown-table-mapping.js';

const carPack = {
  pack: 'cars', version: 1, locale: { default: 'en', supported: ['en'] }, persona: { tone: 'plain', currency: 'USD' },
  catalog: {
    car: { attributes: { name: { type: 'text', required: true }, category: { type: 'enum', values_from: 'data' }, year: { type: 'int', min: 1990, max: 2030 }, daily_rate: { type: 'money', min: 1 }, available: { type: 'boolean' }, metadata: { type: 'map' } } },
  },
  slots: { days: { type: 'int' } }, rules: [], bundle: { pick: 'car' }, objectives: { price: { direction: 'min', weight: 1 } }, results: { count: 1, diversity: 0 },
} as unknown as Pack;
const umrahPack = {
  ...carPack, pack: 'umrah-stays', catalog: {
    hotel: { attributes: { name: { type: 'text', required: true }, city: { type: 'enum', values_from: 'data' } }, children: 'room' },
    room: { attributes: { room_type: 'text', capacity: { type: 'int' } }, children: 'rate' },
    rate: { attributes: { price: { type: 'money' }, valid_from: { type: 'date' }, valid_to: { type: 'date' } } },
  },
} as unknown as Pack;

function mapped(pack: Pack, headers: string[], values: string[][]): MarkdownRowMaterializationRequest {
  const schema = generateCatalogSchema(pack);
  const entity = Object.keys(pack.catalog)[0];
  return {
    mapped: { status: 'mapped', entity, headers: headers.map((source) => ({ source, normalized: source.toLowerCase(), attribute: source.toLowerCase() })), rows: values.map((row, order) => ({ order, rowNumber: order + 10, values: Object.fromEntries(headers.map((header, i) => [header.toLowerCase(), row[i]])) })), provenance: { tableId: 'table-1', sourceId: 'source-1', blockId: 'block-1', headingPath: ['Cars'], startLine: 5, endLine: 8, headerRowNumber: 5 } },
    pack, schema, datasetVersion: 7,
  };
}

describe('deterministic Markdown row materialization and semantic validation', () => {
  it('materializes typed rows, adds only system fields, and preserves source diagnostics', () => {
    const result = materializeMarkdownRows(mapped(carPack, ['id', 'name', 'category', 'year', 'daily_rate', 'available', 'metadata'], [['C-1', 'Sedan', 'SUV', '2024', '12.50', 'yes', '{"doors":4}']]));
    expect(result).toEqual({
      publishable: true,
      accepted: [{
        entity: 'car', values: { id: 'C-1', dataset_version: 7, name: 'Sedan', category: 'SUV', year: 2024, daily_rate: 12.5, available: true, metadata: { doors: 4 } },
        rawValues: ['C-1', 'Sedan', 'SUV', '2024', '12.50', 'yes', '{"doors":4}'],
        sourceHeaders: ['id', 'name', 'category', 'year', 'daily_rate', 'available', 'metadata'],
        mapping: [{ source: 'id', normalized: 'id', attribute: 'id' }, { source: 'name', normalized: 'name', attribute: 'name' }, { source: 'category', normalized: 'category', attribute: 'category' }, { source: 'year', normalized: 'year', attribute: 'year' }, { source: 'daily_rate', normalized: 'daily_rate', attribute: 'daily_rate' }, { source: 'available', normalized: 'available', attribute: 'available' }, { source: 'metadata', normalized: 'metadata', attribute: 'metadata' }],
        provenance: expect.objectContaining({ tableId: 'table-1', sourceId: 'source-1', rowNumber: 10, order: 0, headingPath: ['Cars'], startLine: 5, endLine: 8, headerRowNumber: 5 }),
      }], rejected: [],
    });
  });

  it('rejects semantic failures with deterministic row-level codes and publishes no partial batch', () => {
    const request = mapped(carPack, ['id', 'name', 'year', 'daily_rate'], [
      ['', 'missing', '2024', '10'], ['C-1', 'ok', '2024', '10'], ['C-2', 'bad-year', 'not-int', '10'], ['C-3', 'too-old', '1980', '0'], ['C-4', '', '2024', '10'], ['C-1', 'duplicate', '2024', '10'],
    ]);
    const result = materializeMarkdownRows(request);
    expect(result.publishable).toBe(false);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected.map((row) => row.code)).toEqual(['MISSING_ID', 'INVALID_VALUE', 'OUT_OF_RANGE', 'REQUIRED_VALUE', 'DUPLICATE_ID']);
  });

  it('rejects source-owned system fields, unsupported types, and invalid dates/order', () => {
    const badTypePack = { ...carPack, catalog: { car: { attributes: { name: { type: 'weird' } } } } } as unknown as Pack;
    const unsupported = materializeMarkdownRows({ ...mapped(carPack, ['id', 'name'], [['C-1', 'x']]), pack: badTypePack });
    expect(unsupported.rejected.map((row) => row.code)).toEqual(['UNSUPPORTED_ATTRIBUTE_TYPE']);
    const system = materializeMarkdownRows(mapped(carPack, ['id', 'dataset_version', 'name'], [['C-1', '9', 'x']]));
    expect(system.rejected[0].code).toBe('RESERVED_FIELD');
    const dateRequest = mapped(umrahPack, ['id', 'price', 'valid_from', 'valid_to'], [['R-1', '10', '2025-02-30', '2025-01-01']]);
    dateRequest.mapped.entity = 'rate';
    dateRequest.parentId = 'R-0';
    expect(materializeMarkdownRows(dateRequest).rejected.map((row) => row.code)).toEqual(['INVALID_VALUE']);
  });

  it('requires an explicit parent for children and supplies only a valid parent_id', () => {
    const request = mapped(umrahPack, ['id', 'room_type', 'capacity'], [['R-1', 'double', '2']]);
    request.mapped.entity = 'room';
    const review = materializeMarkdownRows(request);
    expect(review.publishable).toBe(false);
    expect(review.rejected[0].code).toBe('PARENT_REQUIRED');
    request.parentId = 'H-1';
    const accepted = materializeMarkdownRows(request);
    expect(accepted.accepted[0].values).toMatchObject({ id: 'R-1', dataset_version: 7, parent_id: 'H-1' });
    const parent = mapped(umrahPack, ['id', 'name'], [['H-1', 'Makkah']]);
    parent.mapped.entity = 'hotel'; parent.parentId = 'wrong';
    expect(materializeMarkdownRows(parent).rejected[0].code).toBe('PARENT_NOT_ALLOWED');
  });

  it('is repeatably deterministic and does not mutate the mapped input', () => {
    const request = mapped(carPack, ['id', 'name'], [['C-2', 'B'], ['C-1', 'A']]);
    const before = structuredClone(request);
    expect(materializeMarkdownRows(request)).toEqual(materializeMarkdownRows(request));
    expect(request).toEqual(before);
  });
});
