import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compilePack } from '@pilgrim/engine';
import { generateCatalogSchema } from '../../catalog-schema/src/index.js';
import {
  CatalogCsvImportError,
  createSourceArtifact,
  importCatalogCsv,
  parseCsv,
} from '../src/index.js';

const carPack = compilePack(`
pack: car-rental
version: 1
locale: { default: en, supported: [en] }
persona: { tone: practical, currency: USD }
catalog:
  car:
    attributes:
      name: { type: text }
      seats: { type: int, min: 1 }
      daily_rate: { type: money, min: 0 }
slots: { pickup_date: { type: date, required: true } }
rules: []
bundle: { pick: car }
objectives: { total_price: { direction: min, weight: 1 } }
results: { count: 3, diversity: 0.2 }
`);
const carSchema = generateCatalogSchema(carPack);

function source(text: string) {
  return createSourceArtifact(new TextEncoder().encode(text));
}

describe('createSourceArtifact', () => {
  it('hashes exact bytes, records length, and does not mutate the caller buffer', () => {
    const bytes = new TextEncoder().encode('id,name\ncar-1,"A, B"\n');
    const before = bytes.slice();
    const artifact = createSourceArtifact(bytes);
    const hash = createHash('sha256').update(before).digest('hex');
    expect(artifact).toMatchObject({ sourceId: hash, sha256: hash, byteLength: before.byteLength });
    expect(Array.from(artifact.bytes)).toEqual(Array.from(before));
    expect(Array.from(bytes)).toEqual(Array.from(before));
    expect(artifact.bytes).not.toBe(bytes);
  });
});

describe('parseCsv', () => {
  it('parses RFC quoted commas, escaped quotes, embedded newlines, and ignores blank lines', () => {
    expect(parseCsv('id,name,note\n1,"A, B","say ""hi""\nthere"\n\n2,C,ok\n')).toEqual({
      headers: ['id', 'name', 'note'],
      rows: [
        { rowNumber: 2, values: ['1', 'A, B', 'say "hi"\nthere'], raw: '1,"A, B","say ""hi""\nthere"' },
        { rowNumber: 5, values: ['2', 'C', 'ok'], raw: '2,C,ok' },
      ],
    });
  });

  it('rejects malformed quoted fields', () => {
    expect(() => parseCsv('id,name\n1,"unterminated\n')).toThrow(CatalogCsvImportError);
  });
});

describe('importCatalogCsv', () => {
  it('imports the Umrah rate child fixture through schema metadata with one request parent', () => {
    const pack = compilePack(readFileSync(new URL('../../../packs/umrah-stays/pack.yaml', import.meta.url), 'utf8'));
    const schema = generateCatalogSchema(pack);
    const result = importCatalogCsv({
      pack, schema, datasetVersion: 3, parentId: 'hotel-1',
      sources: { rate: source('id,price,valid_from,valid_to\nrate-1,450.00,2026-01-01,2026-01-31\n') },
    });
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].values).toEqual({ id: 'rate-1', dataset_version: 3, parent_id: 'hotel-1', price: 450, valid_from: '2026-01-01', valid_to: '2026-01-31' });
  });

  it('converts generic scalar values and preserves row/source provenance deterministically', () => {
    const request = {
      pack: carPack,
      schema: carSchema,
      datasetVersion: 7,
      sources: { car: source('id,name,seats,daily_rate\ncar-2,"A, B",4,12.50\n') },
    };
    const first = importCatalogCsv(request);
    const second = importCatalogCsv(request);
    expect(first).toEqual(second);
    expect(first.accepted).toEqual([{
      entity: 'car',
      values: { id: 'car-2', dataset_version: 7, name: 'A, B', seats: 4, daily_rate: 12.5 },
      provenance: { sourceId: request.sources.car.sourceId, rowNumber: 2, rawValues: ['car-2', 'A, B', '4', '12.50'] },
    }]);
    expect(first.rejected).toEqual([]);
  });

  it('returns partial accepted and rejected rows for duplicate ids, conversion, and range errors', () => {
    const result = importCatalogCsv({
      pack: carPack, schema: carSchema, datasetVersion: 1,
      sources: { car: source('id,name,seats,daily_rate\na,Good,4,10\na,Duplicate,4,10\nb,BadInt,nope,10\nc,BadRange,0,10\n') },
    });
    expect(result.accepted.map((row) => row.values.id)).toEqual(['a']);
    expect(result.rejected.map((row) => row.error.code)).toEqual(['DUPLICATE_ID', 'INVALID_VALUE', 'OUT_OF_RANGE']);
    expect(result.rejected[1].provenance.rowNumber).toBe(4);
  });

  it.each([
    ['missing', 'id,name,seats\na,A,4\n', 'MISSING_HEADER'],
    ['extra', 'id,name,seats,daily_rate,unknown\na,A,4,1,x\n', 'EXTRA_HEADER'],
    ['duplicate', 'id,name,seats,daily_rate,daily_rate\na,A,4,1,1\n', 'DUPLICATE_HEADER'],
  ])('rejects %s headers without dropping the source row', (_label, csv, code) => {
    const result = importCatalogCsv({ pack: carPack, schema: carSchema, datasetVersion: 1, sources: { car: source(csv) } });
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].error.code).toBe(code);
  });

  it('requires explicit ids, reserves generated columns, and applies request-level parent semantics', () => {
    const result = importCatalogCsv({
      pack: carPack, schema: carSchema, datasetVersion: 1, parentId: 'not-a-car',
      sources: { car: source('name,seats,dataset_version\nA,4,99\n') },
    });
    expect(result.rejected.map((row) => row.error.code)).toEqual(['RESERVED_HEADER', 'MISSING_HEADER', 'MISSING_HEADER', 'PARENT_NOT_ALLOWED']);
  });
});
