import { createHash } from 'node:crypto';
import { createSourceArtifact } from './source-artifact.js';
import type { SourceArtifact } from './source-artifact.js';
import type { CatalogSchemaArtifact } from '../../catalog-schema/src/types.js';
import type { Pack } from '../../engine/src/index.js';
export {
  MAX_SOURCE_ARTIFACT_BYTES,
  SOURCE_ARTIFACT_PREFIX,
  SourceArtifactError,
  createInMemorySourceArtifactStore,
  createSourceArtifact,
  sourceArtifactKey,
  verifySourceArtifact,
} from './source-artifact.js';
export type {
  InMemorySourceArtifactStoreOptions,
  PutIfAbsentResult,
  SourceArtifact,
  SourceArtifactHead,
  SourceArtifactKind,
  SourceArtifactOptions,
  SourceArtifactStore,
} from './source-artifact.js';
export { ingestCsvSource } from './csv-connector.js';
export type { CsvConnectorRequest, CsvConnectorResult, CsvSourceManifest } from './csv-connector.js';
export { parseActualUmrahRates, ACTUAL_UMRAH_HEADERS } from './actual-umrah.js';
export type { ActualUmrahRateRow, ActualUmrahRates, ShadowDate } from './actual-umrah.js';
export {
  ACTUAL_UMRAH_CITY_ALIASES,
  ACTUAL_UMRAH_OCCUPANCY_MAPPINGS,
  mapActualUmrahRatesToCanonical,
} from './actual-umrah-canonical.js';
export type {
  ActualUmrahCanonicalStaging,
  BlankCellLedgerEntry,
  CanonicalHotel,
  CanonicalPeriod,
  CanonicalRate,
  CanonicalRoom,
  CanonicalSourceRef,
} from './actual-umrah-canonical.js';
export {
  createStagingDiff,
  diffStagingSnapshots,
  serializeStagingDiff,
  StagingDiffError,
} from './staging-diff.js';
export type {
  ChangedRecord,
  StagingDiffReason,
  StagingDiffRequest,
  StagingDiffResult,
  StagingEntityDiff,
} from './staging-diff.js';
export {
  createPublishPlan,
  createReview,
  createRollbackPlan,
  createVersionLifecycle,
  serializeVersionLifecycle,
  VersionLifecycleError,
} from './version-lifecycle.js';
export type {
  PublishPlan,
  ReviewRequest,
  ReviewStatus,
  RollbackPlan,
  RollbackRequest,
  VersionLifecycle,
  VersionManifest,
  VersionReview,
  VersionedEntity,
} from './version-lifecycle.js';
export {
  createInMemoryPublicationAdapter,
  executePublication,
  materializeVersion,
  PublicationError,
} from './publication.js';
export type {
  ExecutePublicationOptions,
  InMemoryPublicationAdapterOptions,
  MaterializedVersion,
  PublicationAdapter,
  PublicationRecord,
  PublicationState,
} from './publication.js';
export {
  createInMemoryPublicationStore,
  publishToStore,
  publicationRecordDigest,
  publicationRecordKey,
  serializePublicationStoreState,
  PublicationStoreError,
} from './publication-store.js';
export type {
  InMemoryPublicationStoreOptions,
  PublicationCacheMetadata,
  PublicationStore,
  PublicationStoreState,
  PublicationTransaction,
  PublishToStoreOptions,
} from './publication-store.js';

export class CatalogCsvImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CatalogCsvImportError';
    this.code = code;
  }
}

export interface CsvRow { rowNumber: number; values: string[]; raw: string; }
export interface ParsedCsv { headers: string[]; rows: CsvRow[]; }

type CsvState = 'field-start' | 'unquoted' | 'quoted' | 'post-quote';

export function parseCsv(input: string | Uint8Array): ParsedCsv {
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
  const records: CsvRow[] = [];
  let values: string[] = [];
  let field = '';
  let state: CsvState = 'field-start';
  let recordStart = 0;
  let rowNumber = 1;
  let line = 1;
  let i = 0;

  const finishRecord = (end: number): void => {
    if (values.length === 0 && field === '' && state === 'field-start') {
      recordStart = end;
      rowNumber = line;
      return;
    }
    values.push(field);
    records.push({ values, raw: text.slice(recordStart, end), rowNumber });
    values = [];
    field = '';
    state = 'field-start';
    recordStart = end;
    rowNumber = line;
  };
  const malformed = (message: string): never => { throw new CatalogCsvImportError('MALFORMED_CSV', message); };

  while (i < text.length) {
    const char = text[i];
    if (state === 'quoted') {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        state = 'post-quote';
        i++;
        continue;
      }
      field += char;
      if (char === '\n') line++;
      i++;
      continue;
    }
    if (state === 'post-quote') {
      if (char === ',') { values.push(field); field = ''; state = 'field-start'; i++; continue; }
      if (char === '\n' || char === '\r') {
        const end = i;
        finishRecord(end);
        if (char === '\r' && text[i + 1] === '\n') i++;
        i++; line++; recordStart = i; rowNumber = line;
        continue;
      }
      malformed('characters after a closing quote must be a comma or record terminator');
    }
    if (state === 'field-start') {
      if (char === '"') { state = 'quoted'; i++; continue; }
      if (char === ',') { values.push(''); i++; continue; }
      if (char === '\n' || char === '\r') {
        finishRecord(i);
        if (char === '\r' && text[i + 1] === '\n') i++;
        i++; line++; recordStart = i; rowNumber = line;
        continue;
      }
      field += char;
      state = 'unquoted';
      i++;
      continue;
    }
    if (char === '"') malformed('quote must begin a field');
    if (char === ',') { values.push(field); field = ''; state = 'field-start'; i++; continue; }
    if (char === '\n' || char === '\r') {
      finishRecord(i);
      if (char === '\r' && text[i + 1] === '\n') i++;
      i++; line++; recordStart = i; rowNumber = line;
      continue;
    }
    field += char;
    i++;
  }
  if (state === 'quoted') throw new CatalogCsvImportError('MALFORMED_CSV', 'unterminated quoted field');
  if (state !== 'field-start' || values.length > 0) finishRecord(text.length);
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
export interface RowProvenance { sourceId: string; rowNumber: number; rawValues: string[]; }
export interface AcceptedCatalogRow { entity: string; values: Record<string, unknown>; provenance: RowProvenance; }
export interface RejectedCatalogRow { entity: string; error: { code: string; message: string }; provenance: RowProvenance; }
export interface CatalogCsvImportResult { accepted: AcceptedCatalogRow[]; rejected: RejectedCatalogRow[]; }

const generatedHeaders = new Set(['dataset_version', 'parent_id']);
const normalize = (value: string): string => value.toLowerCase();
function reject(entity: string, sourceId: string, rowNumber: number, rawValues: string[], code: string, message: string): RejectedCatalogRow {
  return { entity, error: { code, message }, provenance: { sourceId, rowNumber, rawValues: [...rawValues] } };
}
function convert(value: string, type: string): unknown {
  if (type === 'text' || type === 'enum' || type === 'date') {
    if (type === 'date') { const date = new Date(`${value}T00:00:00Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new CatalogCsvImportError('INVALID_VALUE', 'invalid date'); }
    return value;
  }
  if (type === 'int') { if (!/^[+-]?\d+$/.test(value)) throw new CatalogCsvImportError('INVALID_VALUE', 'invalid integer'); return Number(value); }
  if (type === 'number' || type === 'money') { if (value.trim() === '' || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) throw new CatalogCsvImportError('INVALID_VALUE', 'invalid number'); return Number(value); }
  if (type === 'boolean') { if (/^(true|1|yes)$/i.test(value)) return true; if (/^(false|0|no)$/i.test(value)) return false; throw new CatalogCsvImportError('INVALID_VALUE', 'invalid boolean'); }
  if (type === 'map') { try { return JSON.parse(value); } catch { throw new CatalogCsvImportError('INVALID_VALUE', 'invalid map JSON'); } }
  throw new CatalogCsvImportError('INVALID_VALUE', `unsupported type ${type}`);
}

function artifactFor(source: SourceArtifact | Uint8Array | string): SourceArtifact {
  return typeof source === 'string' ? createSourceArtifact(new TextEncoder().encode(source)) : source instanceof Uint8Array ? createSourceArtifact(source) : source;
}
function verifyArtifact(artifact: SourceArtifact): void {
  const hash = createHash('sha256').update(artifact.bytes).digest('hex');
  if (artifact.sourceId !== hash || artifact.sha256 !== hash || artifact.byteLength !== artifact.bytes.byteLength) {
    throw new CatalogCsvImportError('SOURCE_PROVENANCE_MISMATCH', 'source artifact metadata does not match its exact bytes');
  }
}

export function importCatalogCsv(request: CatalogCsvImportRequest): CatalogCsvImportResult {
  const accepted: AcceptedCatalogRow[] = [];
  const rejected: RejectedCatalogRow[] = [];
  const seen = new Set<string>();
  const entityEntries = Object.entries(request.pack.catalog).map(([rawName, config]) => ({ rawName, name: normalize(rawName), config }));
  const entityByName = new Map(entityEntries.map((entry) => [entry.name, entry]));
  const ambiguousEntities = new Set<string>();
  for (const entry of entityEntries) if (entityEntries.filter((candidate) => candidate.name === entry.name).length > 1) ambiguousEntities.add(entry.name);
  const schemaByName = new Map(request.schema.tables.filter((table) => table.name !== 'catalog_versions').map((table) => [normalize(table.name), table]));
  const sourceEntries = Object.entries(request.sources).sort(([left], [right]) => left.localeCompare(right));
  const normalizedSourceKeys = new Map<string, string>();
  const ambiguousSourceKeys = new Set<string>();
  for (const [rawKey] of sourceEntries) {
    const name = normalize(rawKey);
    const previous = normalizedSourceKeys.get(name);
    if (previous !== undefined) { ambiguousSourceKeys.add(name); rejected.push(reject(rawKey, artifactFor(request.sources[rawKey]).sourceId, 1, [], 'NORMALIZED_COLLISION', `source keys ${previous} and ${rawKey} normalize to ${name}`)); }
    else normalizedSourceKeys.set(name, rawKey);
  }

  for (const [rawSourceKey, source] of sourceEntries) {
    const artifact = artifactFor(source);
    try { verifyArtifact(artifact); } catch (error) {
      const issue = error as CatalogCsvImportError;
      rejected.push(reject(rawSourceKey, artifact.sourceId, 1, [], issue.code, issue.message));
      continue;
    }
    const entityName = normalize(rawSourceKey);
    if (ambiguousSourceKeys.has(entityName)) {
      if (rawSourceKey === normalizedSourceKeys.get(entityName)) rejected.push(reject(rawSourceKey, artifact.sourceId, 1, [], 'NORMALIZED_COLLISION', `source keys normalize to ${entityName}`));
      continue;
    }
    const entityEntry = entityByName.get(entityName);
    if (!entityEntry || !schemaByName.has(entityName)) { rejected.push(reject(rawSourceKey, artifact.sourceId, 1, [], 'UNKNOWN_ENTITY', `unknown entity ${rawSourceKey}`)); continue; }
    if (ambiguousEntities.has(entityName)) { rejected.push(reject(rawSourceKey, artifact.sourceId, 1, [], 'NORMALIZED_COLLISION', `pack entities normalize to ${entityName}`)); continue; }
    if (rawSourceKey !== normalizedSourceKeys.get(entityName)) continue;
    const entity = entityEntry.name;
    const config = entityEntry.config as { attributes: Record<string, string | { type: string; min?: number; max?: number; required?: boolean; role?: string }>; children?: string };
    const attributeNames = Object.keys(config.attributes).map(normalize);
    if (new Set(attributeNames).size !== attributeNames.length) { rejected.push(reject(entity, artifact.sourceId, 1, [], 'NORMALIZED_COLLISION', `pack attributes normalize ambiguously for ${entity}`)); continue; }
    let parsed: ParsedCsv;
    try { parsed = parseCsv(artifact.bytes); } catch (error) {
      const issue = error instanceof CatalogCsvImportError ? error : new CatalogCsvImportError('MALFORMED_CSV', String(error));
      rejected.push(reject(entity, artifact.sourceId, 1, [], issue.code, issue.message));
      continue;
    }
    const attrsByName = new Map(Object.keys(config.attributes).map((rawName) => [normalize(rawName), { definition: config.attributes[rawName] }]));
    const expected = ['id', ...attrsByName.keys()];
    const headerNames = new Map<string, string>();
    let collision: { name: string; exact: boolean } | undefined;
    for (const rawHeader of parsed.headers) {
      const name = normalize(rawHeader);
      const previous = headerNames.get(name);
      if (previous !== undefined) collision = { name, exact: previous === rawHeader };
      else headerNames.set(name, rawHeader);
    }
    if (collision) {
      const code = collision.exact ? 'DUPLICATE_HEADER' : 'NORMALIZED_COLLISION';
      rejected.push(reject(entity, artifact.sourceId, 1, parsed.headers, code, `headers normalize to the same identifier: ${collision.name}`));
      continue;
    }
    const normalizedHeaders = parsed.headers.map(normalize);
    const headerErrors: RejectedCatalogRow[] = [];
    for (const header of generatedHeaders) if (normalizedHeaders.includes(header)) headerErrors.push(reject(entity, artifact.sourceId, 1, parsed.headers, 'RESERVED_HEADER', `reserved header ${header}`));
    for (const required of expected) if (!normalizedHeaders.includes(required)) headerErrors.push(reject(entity, artifact.sourceId, 1, parsed.headers, 'MISSING_HEADER', `missing header ${required}`));
    for (const extra of normalizedHeaders) if (!expected.includes(extra) && !generatedHeaders.has(extra)) headerErrors.push(reject(entity, artifact.sourceId, 1, parsed.headers, 'EXTRA_HEADER', `extra header ${extra}`));
    const isChild = entityEntries.some((entry) => entry.config.children !== undefined && normalize(entry.config.children) === entity);
    if (request.parentId && !isChild) headerErrors.push(reject(entity, artifact.sourceId, 1, parsed.headers, 'PARENT_NOT_ALLOWED', 'parentId is only valid for child entity imports'));
    if (!request.parentId && isChild) headerErrors.push(reject(entity, artifact.sourceId, 1, parsed.headers, 'PARENT_REQUIRED', 'child entity import requires parentId'));
    if (headerErrors.length) { rejected.push(...headerErrors); continue; }
    const positions = new Map(normalizedHeaders.map((header, index) => [header, index]));
    for (const row of parsed.rows) {
      if (row.values.length !== parsed.headers.length) { rejected.push(reject(entity, artifact.sourceId, row.rowNumber, row.values, 'ROW_WIDTH_MISMATCH', `row has ${row.values.length} fields; expected ${parsed.headers.length}`)); continue; }
      const id = row.values[positions.get('id')!]?.trim();
      if (!id) { rejected.push(reject(entity, artifact.sourceId, row.rowNumber, row.values, 'MISSING_ID', 'id is required')); continue; }
      const key = `${entity}\u0000${id}`;
      if (seen.has(key)) { rejected.push(reject(entity, artifact.sourceId, row.rowNumber, row.values, 'DUPLICATE_ID', `duplicate id ${id}`)); continue; }
      try {
        const values: Record<string, unknown> = { id, dataset_version: request.datasetVersion };
        if (request.parentId) values.parent_id = request.parentId;
        for (const name of attrsByName.keys()) {
          const definition = attrsByName.get(name)!.definition;
          const type = typeof definition === 'string' ? definition : definition.type;
          const raw = row.values[positions.get(name)!] ?? '';
          if (raw === '') { if (typeof definition !== 'string' && definition.required) throw new CatalogCsvImportError('REQUIRED_VALUE', `${name} is required`); continue; }
          const converted = convert(raw, type);
          if (typeof definition !== 'string' && (definition.min !== undefined && Number(converted) < definition.min || definition.max !== undefined && Number(converted) > definition.max)) throw new CatalogCsvImportError('OUT_OF_RANGE', `${name} is outside its range`);
          values[name] = converted;
        }
        const from = values.valid_from ?? values[Object.keys(config.attributes).find((name) => normalize(name) === 'valid_from') ?? ''];
        const to = values.valid_to ?? values[Object.keys(config.attributes).find((name) => normalize(name) === 'valid_to') ?? ''];
        if (typeof from === 'string' && typeof to === 'string' && from > to) throw new CatalogCsvImportError('DATE_ORDER', 'valid_from must not be after valid_to');
        accepted.push({ entity, values, provenance: { sourceId: artifact.sourceId, rowNumber: row.rowNumber, rawValues: [...row.values] } });
        seen.add(key);
      } catch (error) { const issue = error instanceof CatalogCsvImportError ? error : new CatalogCsvImportError('INVALID_VALUE', String(error)); rejected.push(reject(entity, artifact.sourceId, row.rowNumber, row.values, issue.code, issue.message)); }
    }
  }
  return { accepted, rejected };
}
