import type {
  ActualUmrahCanonicalStaging,
  BlankCellLedgerEntry,
  CanonicalHotel,
  CanonicalPeriod,
  CanonicalRate,
  CanonicalRoom,
} from './actual-umrah-canonical.js';

export type StagingDiffReason =
  | 'price'
  | 'validity period'
  | 'meal plan'
  | 'occupancy availability'
  | 'entity lifecycle'
  | 'provenance';

type DiffRecord<T> = { id: string; record: T; reasons: StagingDiffReason[] };
export interface ChangedRecord<T> { id: string; before: T; after: T; reasons: StagingDiffReason[]; }
export interface StagingEntityDiff<T> {
  added: DiffRecord<T>[];
  removed: DiffRecord<T>[];
  changed: ChangedRecord<T>[];
}
export interface StagingDiffResult {
  version: { parentVersion: string; candidateVersion: string };
  sources: { parent?: ActualUmrahCanonicalStaging['source']; candidate: ActualUmrahCanonicalStaging['source'] };
  review: { status: 'pending'; approved: false };
  diff: {
    hotels: StagingEntityDiff<CanonicalHotel>;
    rooms: StagingEntityDiff<CanonicalRoom>;
    rates: StagingEntityDiff<CanonicalRate>;
    periods: StagingEntityDiff<CanonicalPeriod>;
    blankCells: StagingEntityDiff<BlankCellLedgerEntry>;
  };
}
export interface StagingDiffRequest {
  parentVersion: string;
  candidateVersion: string;
  parent?: ActualUmrahCanonicalStaging;
  candidate: ActualUmrahCanonicalStaging;
}

export class StagingDiffError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'StagingDiffError';
    this.code = code;
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    const copy = value.map(stable);
    return copy.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}
function serialize(value: unknown): string { return JSON.stringify(stable(value)); }
function without<T extends object, K extends keyof T>(record: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...record } as T;
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}
function reasonSet(...reasons: StagingDiffReason[]): StagingDiffReason[] {
  return [...new Set(reasons)];
}
function provenanceChanged(before: { source?: unknown }, after: { source?: unknown }): boolean {
  return serialize(before.source) !== serialize(after.source);
}
function semanticChanged(before: unknown, after: unknown): boolean { return serialize(before) !== serialize(after); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSnapshot(snapshot: unknown, label: string): asserts snapshot is ActualUmrahCanonicalStaging {
  if (!isRecord(snapshot)) throw new StagingDiffError('INVALID_SNAPSHOT', `${label} snapshot must be an object`);
  if (snapshot.status !== 'staging') throw new StagingDiffError('NON_STAGING', `${label} snapshot must have staging status`);
  if (snapshot.recommenderReady !== false) throw new StagingDiffError('RECOMMENDER_READY', `${label} snapshot must not be recommender-ready`);
  if (!isRecord(snapshot.semantics) || snapshot.semantics.currency !== 'SAR' || snapshot.semantics.priceBasis !== 'per room per night' || snapshot.semantics.provisional !== true) {
    throw new StagingDiffError('SEMANTICS_MISMATCH', `${label} snapshot has unsupported staging semantics`);
  }
  const collections = [
    ['hotels', snapshot.hotels, (record: CanonicalHotel) => record.id],
    ['rooms', snapshot.rooms, (record: CanonicalRoom) => record.id],
    ['rates', snapshot.rates, (record: CanonicalRate) => record.id],
    ['periods', snapshot.periods, (record: CanonicalPeriod) => `${record.validFrom}\u0000${record.validTo}`],
    ['blankCells', snapshot.blankCells, (record: BlankCellLedgerEntry) => `${record.rowNumber}\u0000${record.column}`],
  ] as const;
  for (const [name, records, key] of collections) {
    if (!Array.isArray(records)) throw new StagingDiffError('INVALID_SNAPSHOT', `${label} ${name} must be an array`);
    const keys = new Set<string>();
    for (const record of records) {
      if (!isRecord(record)) throw new StagingDiffError('INVALID_SNAPSHOT', `${label} ${name} contains a non-object record`);
      const id = key(record as never);
      if (!id || keys.has(id)) throw new StagingDiffError('DUPLICATE_KEY', `${label} ${name} has a duplicate or empty key`);
      keys.add(id);
    }
  }
}

function entityDiff<T>(
  parent: T[], candidate: T[], key: (record: T) => string,
  compare: (before: T, after: T) => { changed: boolean; reasons: StagingDiffReason[] },
  addedReason: StagingDiffReason = 'entity lifecycle',
): StagingEntityDiff<T> {
  const before = new Map(parent.map((record) => [key(record), record]));
  const after = new Map(candidate.map((record) => [key(record), record]));
  const added = [...after.keys()].filter((id) => !before.has(id)).sort().map((id) => ({ id, record: after.get(id)!, reasons: [addedReason] }));
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort().map((id) => ({ id, record: before.get(id)!, reasons: [addedReason] }));
  const changed = [...before.keys()].filter((id) => after.has(id)).sort().flatMap((id) => {
    const left = before.get(id)!;
    const right = after.get(id)!;
    const result = compare(left, right);
    return result.changed ? [{ id, before: left, after: right, reasons: result.reasons }] : [];
  });
  return { added, removed, changed };
}

function compareWithSource<T extends { source?: unknown }>(
  before: T, after: T, semanticBefore: unknown, semanticAfter: unknown,
): { changed: boolean; reasons: StagingDiffReason[] } {
  const reasons: StagingDiffReason[] = [];
  if (semanticChanged(semanticBefore, semanticAfter)) reasons.push('entity lifecycle');
  if (provenanceChanged(before, after)) reasons.push('provenance');
  return { changed: reasons.length > 0, reasons };
}

export function diffStagingSnapshots(request: StagingDiffRequest): StagingDiffResult {
  if (!isRecord(request)) throw new StagingDiffError('INVALID_REQUEST', 'staging diff request must be an object');
  if (typeof request.parentVersion !== 'string' || request.parentVersion.length === 0 || typeof request.candidateVersion !== 'string' || request.candidateVersion.length === 0) {
    throw new StagingDiffError('INVALID_VERSION', 'parentVersion and candidateVersion must be non-empty strings');
  }
  if (request.parent !== undefined) validateSnapshot(request.parent, 'parent');
  validateSnapshot(request.candidate, 'candidate');
  const parent = request.parent;
  const candidate = request.candidate;
  if (parent !== undefined && serialize(parent.semantics) !== serialize(candidate.semantics)) throw new StagingDiffError('SEMANTICS_MISMATCH', 'parent and candidate semantics must match');
  const empty = <T>(): T[] => [];
  const parentOrEmpty = <T>(records: T[] | undefined): T[] => parent === undefined ? empty<T>() : records ?? empty<T>();

  const hotels = entityDiff(parentOrEmpty(parent?.hotels), candidate.hotels, (record) => record.id, (before, after) => compareWithSource(before, after, without(before, 'source', 'rooms'), without(after, 'source', 'rooms')));
  const rooms = entityDiff(parentOrEmpty(parent?.rooms), candidate.rooms, (record) => record.id, (before, after) => compareWithSource(before, after, without(before, 'source', 'rates'), without(after, 'source', 'rates')));
  const rates = entityDiff(parentOrEmpty(parent?.rates), candidate.rates, (record) => record.id, (before, after) => {
    const reasons: StagingDiffReason[] = [];
    if (before.price !== after.price) reasons.push('price');
    if (before.validFrom !== after.validFrom || before.validTo !== after.validTo || before.validFromRaw !== after.validFromRaw || before.validToRaw !== after.validToRaw) reasons.push('validity period');
    if (before.mealPlan !== after.mealPlan) reasons.push('meal plan');
    const semanticBefore = without(before, 'source', 'price', 'mealPlan', 'validFrom', 'validTo', 'validFromRaw', 'validToRaw');
    const semanticAfter = without(after, 'source', 'price', 'mealPlan', 'validFrom', 'validTo', 'validFromRaw', 'validToRaw');
    if (semanticChanged(semanticBefore, semanticAfter)) reasons.push('entity lifecycle');
    if (provenanceChanged(before, after)) reasons.push('provenance');
    return { changed: reasons.length > 0, reasons: reasonSet(...reasons) };
  });
  const periods = entityDiff(parentOrEmpty(parent?.periods), candidate.periods, (record) => `${record.validFrom}\u0000${record.validTo}`, (before, after) => ({ changed: semanticChanged(before, after), reasons: ['validity period'] }));
  const blankCells = entityDiff(parentOrEmpty(parent?.blankCells), candidate.blankCells, (record) => `${record.rowNumber}\u0000${record.column}`, (before, after) => {
    const reasons: StagingDiffReason[] = [];
    if (semanticChanged(without(before, 'sourceId', 'sha256', 'raw', 'rawValues'), without(after, 'sourceId', 'sha256', 'raw', 'rawValues'))) reasons.push('occupancy availability');
    if (provenanceChanged({ source: { sourceId: before.sourceId, sha256: before.sha256, raw: before.raw, rawValues: before.rawValues } }, { source: { sourceId: after.sourceId, sha256: after.sha256, raw: after.raw, rawValues: after.rawValues } })) reasons.push('provenance');
    return { changed: reasons.length > 0, reasons: reasonSet(...reasons) };
  });

  return {
    version: { parentVersion: request.parentVersion, candidateVersion: request.candidateVersion },
    sources: { ...(parent === undefined ? {} : { parent: parent.source }), candidate: candidate.source },
    review: { status: 'pending', approved: false },
    diff: { hotels, rooms, rates, periods, blankCells },
  };
}

export const createStagingDiff = diffStagingSnapshots;
export function serializeStagingDiff(result: StagingDiffResult): string { return serialize(result); }
