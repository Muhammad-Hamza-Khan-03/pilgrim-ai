import { createHash } from 'node:crypto';
import type { CatalogSchemaArtifact } from '../../catalog-schema/src/types.js';
import type { Pack } from '../../engine/src/index.js';

export interface SourceArtifact {
  sourceId: string;
  sha256: string;
  byteLength: number;
  bytes: Uint8Array;
}

export function createSourceArtifact(bytes: Uint8Array): SourceArtifact {
  const copy = new Uint8Array(bytes);
  const sha256 = createHash('sha256').update(copy).digest('hex');
  return { sourceId: sha256, sha256, byteLength: copy.byteLength, bytes: copy };
}

export class CatalogCsvImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CatalogCsvImportError';
    this.code = code;
  }
}

export interface CsvRow {
  rowNumber: number;
  values: string[];
  raw: string;
}

export interface ParsedCsv {
  headers: string[];
  rows: CsvRow[];
}

export function parseCsv(input: string | Uint8Array): ParsedCsv {
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
  const records: Array<{ values: string[]; raw: string; rowNumber: number }> = [];
  let values: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldQuoted = false;
  let recordStart = 1;
  let line = 1;
  let rawStart = 0;
  let i = 0;
  const finishRecord = (end: number) => {
    if (values.length === 0 && field === '' && !fieldQuoted) {
      values = [];
      field = '';
      fieldQuoted = false;
      rawStart = end;
      recordStart = line;
      return;
    }
    values.push(field);
    records.push({ values, raw: text.slice(rawStart, end), rowNumber: recordStart });
    values = [];
    field = '';
    fieldQuoted = false;
    rawStart = end;
    recordStart = line;
  };
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += char;
      if (char === '\n') line++;
      i++;
      continue;
    }
    if (char === '"') {
      if (field.length !== 0) throw new CatalogCsvImportError('MALFORMED_CSV', 'quote must begin a field');
      inQuotes = true; fieldQuoted = true; i++; continue;
    }
    if (char === ',') { values.push(field); field = ''; i++; continue; }
    if (char === '\n' || char === '\r') {
      const end = char === '\r' && text[i + 1] === '\n' ? i : i;
      finishRecord(end);
      if (char === '\r' && text[i + 1] === '\n') i++;
      i++; line++; rawStart = i; recordStart = line;
      continue;
    }
    field += char; i++;
  }
  if (inQuotes) throw new CatalogCsvImportError('MALFORMED_CSV', 'unterminated quoted field');
  if (field.length > 0 || values.length > 0 || fieldQuoted) finishRecord(text.length);
  if (records.length === 0) throw new CatalogCsvImportError('MISSING_HEADER', 'CSV has no header');
  const [header, ...rows] = records;
  if (header.values.some((value) => value === '')) throw new CatalogCsvImportError('MISSING_HEADER', 'CSV header contains an empty name');
  return { headers: header.values, rows };
}

export interface CatalogCsvImportRequest {
  pack: Pack;
  schema: CatalogSchemaArtifact;
  datasetVersion: number;
  parentId?: string;
  sources: Record<string, SourceArtifact | Uint8Array | string>;
}

export interface RowProvenance {
  sourceId: string;
  rowNumber: number;
  rawValues: string[];
}

export interface AcceptedCatalogRow {
  entity: string;
  values: Record<string, unknown>;
  provenance: RowProvenance;
}

export interface RejectedCatalogRow {
  entity: string;
  error: { code: string; message: string };
  provenance: RowProvenance;
}

export interface CatalogCsvImportResult {
  accepted: AcceptedCatalogRow[];
  rejected: RejectedCatalogRow[];
}

const generatedHeaders = new Set(['dataset_version', 'parent_id']);

function reject(entity: string, sourceId: string, rowNumber: number, rawValues: string[], code: string, message: string): RejectedCatalogRow {
  return { entity, error: { code, message }, provenance: { sourceId, rowNumber, rawValues: [...rawValues] } };
}

function convert(value: string, type: string): unknown {
  if (type === 'text' || type === 'enum' || type === 'date') {
    if (type === 'date') {
      const date = new Date(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new CatalogCsvImportError('INVALID_VALUE', 'invalid date');
    }
    return value;
  }
  if (type === 'int') { if (!/^[+-]?\d+$/.test(value)) throw new CatalogCsvImportError('INVALID_VALUE', 'invalid integer'); return Number(value); }
  if (type === 'number' || type === 'money') { if (value.trim() === '' || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) throw new CatalogCsvImportError('INVALID_VALUE', 'invalid number'); return Number(value); }
  if (type === 'boolean') { if (/^(true|1|yes)$/i.test(value)) return true; if (/^(false|0|no)$/i.test(value)) return false; throw new CatalogCsvImportError('INVALID_VALUE', 'invalid boolean'); }
  if (type === 'map') { try { return JSON.parse(value); } catch { throw new CatalogCsvImportError('INVALID_VALUE', 'invalid map JSON'); } }
  throw new CatalogCsvImportError('INVALID_VALUE', `unsupported type ${type}`);
}

export function importCatalogCsv(request: CatalogCsvImportRequest): CatalogCsvImportResult {
  const accepted: AcceptedCatalogRow[] = [];
  const rejected: RejectedCatalogRow[] = [];
  const seen = new Set<string>();
  const entityNames = Object.keys(request.pack.catalog).sort();
  for (const entity of Object.keys(request.sources).sort()) {
    if (!request.pack.catalog[entity] || !request.schema.tables.some((table) => table.name === entity)) {
      const artifact = request.sources[entity];
      const sourceId = typeof artifact === 'string' || artifact instanceof Uint8Array ? createSourceArtifact(typeof artifact === 'string' ? new TextEncoder().encode(artifact) : artifact).sourceId : artifact.sourceId;
      rejected.push(reject(entity, sourceId, 1, [], 'UNKNOWN_ENTITY', `unknown entity ${entity}`));
      continue;
    }
    const rawSource = request.sources[entity];
    const artifact = typeof rawSource === 'string' ? createSourceArtifact(new TextEncoder().encode(rawSource)) : rawSource instanceof Uint8Array ? createSourceArtifact(rawSource) : rawSource;
    let parsed: ParsedCsv;
    try { parsed = parseCsv(artifact.bytes); } catch (error) {
      rejected.push(reject(entity, artifact.sourceId, 1, [], error instanceof CatalogCsvImportError ? error.code : 'MALFORMED_CSV', error instanceof Error ? error.message : String(error)));
      continue;
    }
    const config = request.pack.catalog[entity] as { attributes: Record<string, string | { type: string; min?: number; max?: number; required?: boolean; role?: string }> ; children?: string };
    const attrs = Object.keys(config.attributes).sort();
    const expected = ['id', ...attrs];
    const headerErrors: RejectedCatalogRow[] = [];
    const duplicate = parsed.headers.find((h, i) => parsed.headers.indexOf(h) !== i);
    if (duplicate) headerErrors.push(reject(entity, artifact.sourceId, 1, parsed.headers, 'DUPLICATE_HEADER', `duplicate header ${duplicate}`));
    for (const header of ['dataset_version', 'parent_id']) if (parsed.headers.includes(header)) headerErrors.push(reject(entity, artifact.sourceId, 1, parsed.headers, 'RESERVED_HEADER', `reserved header ${header}`));
    for (const required of expected) if (!parsed.headers.includes(required)) headerErrors.push(reject(entity, artifact.sourceId, 1, parsed.headers, 'MISSING_HEADER', `missing header ${required}`));
    for (const extra of parsed.headers) if (!expected.includes(extra) && !generatedHeaders.has(extra)) headerErrors.push(reject(entity, artifact.sourceId, 1, parsed.headers, 'EXTRA_HEADER', `extra header ${extra}`));
    const isChild = entityNames.some((name) => request.pack.catalog[name].children === entity);
    if (request.parentId && !isChild) headerErrors.push(reject(entity, artifact.sourceId, 1, parsed.headers, 'PARENT_NOT_ALLOWED', 'parentId is only valid for child entity imports'));
    if (!request.parentId && isChild) headerErrors.push(reject(entity, artifact.sourceId, 1, parsed.headers, 'PARENT_REQUIRED', 'child entity import requires parentId'));
    if (headerErrors.length) { rejected.push(...headerErrors); continue; }
    const positions = new Map(parsed.headers.map((h, i) => [h, i]));
    for (const row of parsed.rows) {
      const provenance = { sourceId: artifact.sourceId, rowNumber: row.rowNumber, rawValues: row.values };
      const id = row.values[positions.get('id')!]?.trim();
      if (!id) { rejected.push(reject(entity, artifact.sourceId, row.rowNumber, row.values, 'MISSING_ID', 'id is required')); continue; }
      const key = `${entity}\u0000${id}`;
      if (seen.has(key)) { rejected.push(reject(entity, artifact.sourceId, row.rowNumber, row.values, 'DUPLICATE_ID', `duplicate id ${id}`)); continue; }
      try {
        const values: Record<string, unknown> = { id, dataset_version: request.datasetVersion };
        if (request.parentId) values.parent_id = request.parentId;
        for (const name of attrs) {
          const definition = config.attributes[name];
          const type = typeof definition === 'string' ? definition : definition.type;
          const raw = row.values[positions.get(name)!] ?? '';
          if (raw === '') { if (typeof definition !== 'string' && definition.required) throw new CatalogCsvImportError('REQUIRED_VALUE', `${name} is required`); continue; }
          const converted = convert(raw, type);
          if (typeof definition !== 'string') {
            if (definition.min !== undefined && Number(converted) < definition.min || definition.max !== undefined && Number(converted) > definition.max) throw new CatalogCsvImportError('OUT_OF_RANGE', `${name} is outside its range`);
          }
          values[name] = converted;
        }
        const from = values.valid_from ?? values[Object.keys(config.attributes).find((name) => (typeof config.attributes[name] !== 'string' && config.attributes[name].role === 'valid_from')) ?? ''];
        const to = values.valid_to ?? values[Object.keys(config.attributes).find((name) => (typeof config.attributes[name] !== 'string' && config.attributes[name].role === 'valid_to')) ?? ''];
        if (typeof from === 'string' && typeof to === 'string' && from > to) throw new CatalogCsvImportError('DATE_ORDER', 'valid_from must not be after valid_to');
        accepted.push({ entity, values, provenance });
        seen.add(key);
      } catch (error) { const issue = error instanceof CatalogCsvImportError ? error : new CatalogCsvImportError('INVALID_VALUE', String(error)); rejected.push(reject(entity, artifact.sourceId, row.rowNumber, row.values, issue.code, issue.message)); }
    }
  }
  return { accepted, rejected };
}
