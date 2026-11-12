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

  it('rejects trailing characters after a closed quoted field', () => {
    expect(() => parseCsv('id,name\n1,"valid"oops\n')).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_CSV' }),
    );
  });

  it('preserves CRLF row parsing and rejects post-quote delimiters', () => {
    expect(parseCsv('id,name\r\n1,"A, B"\r\n')).toEqual({
      headers: ['id', 'name'],
      rows: [{ rowNumber: 2, values: ['1', 'A, B'], raw: '1,"A, B"' }],
    });
    expect(() => parseCsv('id,name\r\n1,"A"x\r\n')).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_CSV' }),
    );
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

  it.each([
    ['too few', 'id,name,seats,daily_rate\na,A,4\n'],
    ['too many', 'id,name,seats,daily_rate\na,A,4,1,unexpected\n'],
  ])('rejects %s row fields with ROW_WIDTH_MISMATCH and preserves raw provenance', (_label, csv) => {
    const result = importCatalogCsv({ pack: carPack, schema: carSchema, datasetVersion: 1, sources: { car: source(csv) } });
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]).toMatchObject({
      error: { code: 'ROW_WIDTH_MISMATCH' },
      provenance: { rowNumber: 2, rawValues: expect.any(Array) },
    });
    expect(result.rejected[0].provenance.rawValues).toEqual(csv.trimEnd().split('\n')[1].split(','));
  });

  it('rejects a tampered supplied source artifact before parsing', () => {
    const artifact = source('id,name,seats,daily_rate\ncar-1,A,4,10\n');
    artifact.bytes[0] = 0x58;
    const result = importCatalogCsv({ pack: carPack, schema: carSchema, datasetVersion: 1, sources: { car: artifact } });
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].error.code).toBe('SOURCE_PROVENANCE_MISMATCH');
  });

  it.each(['sources/sha256/not-content-addressed', '../escape.csv'])('rejects forged source artifact keys before parsing: %s', (key) => {
    const artifact = source('id,name,seats,daily_rate\ncar-1,A,4,10\n');
    artifact.key = key;
    const result = importCatalogCsv({ pack: carPack, schema: carSchema, datasetVersion: 1, sources: { car: artifact } });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].error.code).toBe('SOURCE_PROVENANCE_MISMATCH');
  });

  it('resolves normalized entity and header identifiers and emits canonical keys', () => {
    const result = importCatalogCsv({
      pack: carPack,
      schema: carSchema,
      datasetVersion: 1,
      sources: { CAR: source('ID,Name,SEATS,DAILY_RATE\ncar-1,A,4,10\n') },
    });
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]).toMatchObject({
      entity: 'car',
      values: { id: 'car-1', name: 'A', seats: 4, daily_rate: 10 },
    });
  });

  it('rejects normalized collisions in source keys and headers', () => {
    const sourceA = source('id,name,seats,daily_rate\ncar-1,A,4,10\n');
    const sourceB = source('id,name,seats,daily_rate\ncar-2,B,4,11\n');
    const sourceCollision = importCatalogCsv({
      pack: carPack, schema: carSchema, datasetVersion: 1,
      sources: { car: sourceA, CAR: sourceB },
    });
    expect(sourceCollision.accepted).toEqual([]);
    expect(sourceCollision.rejected.filter((row) => row.error.code === 'NORMALIZED_COLLISION')).toHaveLength(2);

    const headerCollision = importCatalogCsv({
      pack: carPack, schema: carSchema, datasetVersion: 1,
      sources: { car: source('id,ID,name,seats,daily_rate\ncar-1,car-1,A,4,10\n') },
    });
    expect(headerCollision.rejected[0].error.code).toBe('NORMALIZED_COLLISION');
  });

  it('rejects ambiguous normalized pack entities and attributes', () => {
    const ambiguousEntityPack = {
      ...carPack,
      catalog: { ...carPack.catalog, CAR: carPack.catalog.car },
    };
    const entityResult = importCatalogCsv({
      pack: ambiguousEntityPack,
      schema: carSchema,
      datasetVersion: 1,
      sources: { car: source('id,name,seats,daily_rate\ncar-1,A,4,10\n') },
    });
    expect(entityResult.rejected[0].error.code).toBe('NORMALIZED_COLLISION');

    const ambiguousAttributePack = {
      ...carPack,
      catalog: { ...carPack.catalog, car: { ...carPack.catalog.car, attributes: { ...carPack.catalog.car.attributes, Name: 'text' } } },
    };
    const attributeResult = importCatalogCsv({
      pack: ambiguousAttributePack,
      schema: carSchema,
      datasetVersion: 1,
      sources: { car: source('id,name,seats,daily_rate\ncar-1,A,4,10\n') },
    });
    expect(attributeResult.rejected[0].error.code).toBe('NORMALIZED_COLLISION');
  });
});
