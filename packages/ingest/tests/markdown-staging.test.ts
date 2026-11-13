import { describe, expect, it } from 'vitest';
import type { MarkdownRowMaterializationResult } from '../src/index.js';
import { stageMarkdownRows } from '../src/index.js';

function accepted(entity: string, id: string, sourceId: string, tableId: string, values: Record<string, unknown>, order: number) {
  return {
    entity,
    values: { id, ...values },
    rawValues: [id, String(values.name ?? values.room_type ?? '')],
    sourceHeaders: ['id', entity === 'hotel' ? 'name' : 'room_type'],
    mapping: [{ source: 'id', normalized: 'id', attribute: 'id' }, { source: entity === 'hotel' ? 'name' : 'room_type', normalized: entity === 'hotel' ? 'name' : 'room_type', attribute: entity === 'hotel' ? 'name' : 'room_type' }],
    provenance: {
      tableId,
      sourceId,
      blockId: `${tableId}-block`,
      headingPath: [entity],
      startLine: order + 1,
      endLine: order + 3,
      headerRowNumber: order + 1,
      rowNumber: order + 2,
      order,
      rawValues: [id, String(values.name ?? values.room_type ?? '')],
      sourceHeaders: ['id', entity === 'hotel' ? 'name' : 'room_type'],
      mapping: [{ source: 'id', normalized: 'id', attribute: 'id' }, { source: entity === 'hotel' ? 'name' : 'room_type', normalized: entity === 'hotel' ? 'name' : 'room_type', attribute: entity === 'hotel' ? 'name' : 'room_type' }],
    },
  };
}

function rejected(entity: string, sourceId: string, tableId: string, order: number): MarkdownRowMaterializationResult['rejected'][number] {
  const provenance = {
    tableId,
    sourceId,
    blockId: `${tableId}-block`,
    headingPath: [entity],
    startLine: order + 1,
    endLine: order + 3,
    headerRowNumber: order + 1,
    rowNumber: order + 2,
    order,
    rawValues: ['', 'bad'],
    sourceHeaders: ['id', 'name'],
    mapping: [{ source: 'id', normalized: 'id', attribute: 'id' }, { source: 'name', normalized: 'name', attribute: 'name' }],
  };
  return { entity, code: 'MISSING_ID', message: 'id is required', rawValues: ['', 'bad'], sourceHeaders: ['id', 'name'], mapping: provenance.mapping, provenance };
}

describe('Phase 2M Markdown staging batch assembly', () => {
  it('assembles deterministic staging output for car-rental and Umrah parent/child rows', () => {
    const car = accepted('car', 'car-2', 'source-cars', 'table-cars', { name: 'SUV' }, 1);
    const hotel = accepted('hotel', 'hotel-1', 'source-umrah', 'table-hotels', { name: 'Makkah Hotel' }, 0);
    const room = accepted('room', 'room-1', 'source-umrah', 'table-rooms', { room_type: 'double', dataset_version: 99, parent_id: 'hotel-1' }, 0);
    const input = {
      datasetVersion: 42,
      results: [
        { publishable: true, accepted: [room, car], rejected: [] },
        { publishable: false, accepted: [hotel], rejected: [rejected('car', 'source-cars', 'table-cars', 2)] },
      ],
    } satisfies Parameters<typeof stageMarkdownRows>[0];

    const output = stageMarkdownRows(input);

    expect(output.status).toBe('staging');
    expect(output.recommenderReady).toBe(false);
    expect(output.datasetVersion).toBe(42);
    expect(output.accepted.map((row) => `${row.entity}:${row.values.id}`)).toEqual(['car:car-2', 'hotel:hotel-1', 'room:room-1']);
    expect(output.accepted.find((row) => row.entity === 'room')?.values).toMatchObject({ dataset_version: 99, parent_id: 'hotel-1' });
    expect(output.rejected).toHaveLength(1);
    expect(output.sources).toEqual([{ sourceId: 'source-cars' }, { sourceId: 'source-umrah' }]);
    expect(output.tables.map((table) => table.tableId)).toEqual(['table-cars', 'table-hotels', 'table-rooms']);
  });

  it('sorts independently of result and row input order, deduplicates metadata, and fail-closes duplicate entity/id', () => {
    const first = accepted('car', 'C-1', 's2', 't2', { name: 'second' }, 2);
    const winner = accepted('car', 'C-1', 's1', 't1', { name: 'first' }, 1);
    const other = accepted('car', 'C-2', 's1', 't1', { name: 'other' }, 0);
    const make = (acceptedRows: typeof first[]) => ({ publishable: true, accepted: acceptedRows, rejected: [] });

    const left = stageMarkdownRows({ datasetVersion: 7, results: [make([first, other]), make([winner])] });
    const right = stageMarkdownRows({ datasetVersion: 7, results: [make([winner]), make([other, first])] });

    expect(left).toEqual(right);
    expect(left.accepted.map((row) => row.values.id)).toEqual(['C-1', 'C-2']);
    expect(left.accepted[0].provenance.sourceId).toBe('s1');
    expect(left.rejected).toHaveLength(1);
    expect(left.rejected[0]).toMatchObject({ entity: 'car', code: 'DUPLICATE_ID', message: 'duplicate entity/id car:C-1' });
    expect(left.rejected[0].provenance.sourceId).toBe('s2');
    expect(left.sources).toEqual([{ sourceId: 's1' }, { sourceId: 's2' }]);
    expect(left.tables.map((table) => table.tableId)).toEqual(['t1', 't2']);
  });

  it('propagates accepted and rejected provenance while deeply isolating input and output', () => {
    const row = accepted('car', 'C-1', 's1', 't1', { name: 'Sedan' }, 0);
    const bad = rejected('car', 's1', 't1', 1);
    const request = { datasetVersion: 3, results: [{ publishable: false, accepted: [row], rejected: [bad] }] } satisfies Parameters<typeof stageMarkdownRows>[0];
    const before = structuredClone(request);

    const output = stageMarkdownRows(request);
    output.accepted[0].values.name = 'mutated';
    output.accepted[0].provenance.headingPath.push('mutated');
    output.rejected[0].provenance.rawValues[0] = 'mutated';

    expect(request).toEqual(before);
    expect(output.accepted[0].provenance.tableId).toBe('t1');
    expect(output.rejected[0].provenance.tableId).toBe('t1');
  });
});
