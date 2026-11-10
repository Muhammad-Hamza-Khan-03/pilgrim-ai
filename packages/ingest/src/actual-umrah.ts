import { createHash } from 'node:crypto';
import { CatalogCsvImportError, parseCsv } from './index.js';
import type { SourceArtifact } from './index.js';

export const ACTUAL_UMRAH_HEADERS = [
  'City',
  'Hotel Name',
  'Period From',
  'Period To',
  'DBL(for 2 persons)',
  'TRP (for 3 persons)',
  'QUAD (for 4 persons)',
  'Suite for 5 Persons',
  'Meal Plan',
  'Category',
] as const;

type ActualHeader = (typeof ACTUAL_UMRAH_HEADERS)[number];

export interface ShadowDate {
  raw: string;
  day: number;
  month: number;
  year: number;
  iso: string;
}

export interface ActualUmrahRateRow {
  rowNumber: number;
  raw: string;
  rawValues: string[];
  sourceId: string;
  city: string;
  hotelName: string;
  periodFrom: ShadowDate;
  periodTo: ShadowDate;
  occupancyValues: {
    DBL: number;
    TRP: number;
    QUAD: number | null;
    'Suite for 5 Persons': number;
  };
  mealPlan: string;
  category: number;
  categoryRaw: string;
}

export interface ActualUmrahRates {
  sourceId: string;
  sha256: string;
  byteLength: number;
  rawBytes: Uint8Array;
  headers: readonly ActualHeader[];
  rows: ActualUmrahRateRow[];
}

function invalid(message: string): never {
  throw new CatalogCsvImportError('ACTUAL_UMRAH_INVALID', message);
}

function verifySource(artifact: SourceArtifact): void {
  const hash = createHash('sha256').update(artifact.bytes).digest('hex');
  if (artifact.sourceId !== hash || artifact.sha256 !== hash || artifact.byteLength !== artifact.bytes.byteLength) {
    throw new CatalogCsvImportError('SOURCE_PROVENANCE_MISMATCH', 'source artifact metadata does not match its exact bytes');
  }
}

function shadowDate(raw: string, label: string): ShadowDate {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!match) invalid(`${label} must use DD/MM/YYYY`);
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    invalid(`${label} is not a valid calendar date`);
  }
  return { raw, day, month, year, iso: `${year.toString().padStart(4, '0')}-${match[2]}-${match[1]}` };
}

function occupancy(raw: string, label: string, nullable: boolean): number | null {
  if (raw === '' && nullable) return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) invalid(`${label} must be a nonblank number`);
  const value = Number(raw);
  if (!Number.isFinite(value)) invalid(`${label} must be finite`);
  return value;
}

function category(raw: string): number {
  if (!/^\d+$/.test(raw)) invalid('Category must be an integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) invalid('Category must be a safe integer');
  return value;
}

function assertExactSourceLines(text: string, rowCount: number): void {
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length - 1 !== rowCount) invalid('source contains blank or unparsed data rows');
  if (lines.slice(1).some((line) => line === '')) invalid('source contains a blank data row');
}

export function parseActualUmrahRates(artifact: SourceArtifact): ActualUmrahRates {
  verifySource(artifact);
  const rawBytes = new Uint8Array(artifact.bytes);
  const text = new TextDecoder().decode(rawBytes);
  const parsed = parseCsv(rawBytes);
  if (parsed.headers.length !== ACTUAL_UMRAH_HEADERS.length || parsed.headers.some((header, index) => header !== ACTUAL_UMRAH_HEADERS[index])) {
    throw new CatalogCsvImportError('ACTUAL_UMRAH_HEADER_MISMATCH', `expected exact source headers in exact order: ${ACTUAL_UMRAH_HEADERS.join(',')}`);
  }
  assertExactSourceLines(text, parsed.rows.length);

  const rows = parsed.rows.map((row) => {
    if (row.values.length !== ACTUAL_UMRAH_HEADERS.length) invalid(`row ${row.rowNumber} has ${row.values.length} fields; expected 10`);
    const values = row.values;
    const categoryRaw = values[9];
    return {
      rowNumber: row.rowNumber,
      raw: row.raw,
      rawValues: [...values],
      sourceId: artifact.sourceId,
      city: values[0],
      hotelName: values[1],
      periodFrom: shadowDate(values[2], 'Period From'),
      periodTo: shadowDate(values[3], 'Period To'),
      occupancyValues: {
        DBL: occupancy(values[4], 'DBL(for 2 persons)', false)!,
        TRP: occupancy(values[5], 'TRP (for 3 persons)', false)!,
        QUAD: occupancy(values[6], 'QUAD (for 4 persons)', true),
        'Suite for 5 Persons': occupancy(values[7], 'Suite for 5 Persons', false)!,
      },
      mealPlan: values[8],
      category: category(categoryRaw),
      categoryRaw,
    } satisfies ActualUmrahRateRow;
  });

  return {
    sourceId: artifact.sourceId,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
    rawBytes,
    headers: ACTUAL_UMRAH_HEADERS,
    rows,
  };
}
