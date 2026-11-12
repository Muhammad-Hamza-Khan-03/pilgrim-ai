import { createPublishPlan, createRollbackPlan } from './version-lifecycle.js';
import type {
  BlankCellLedgerEntry,
  CanonicalHotel,
  CanonicalPeriod,
  CanonicalRate,
  CanonicalRoom,
} from './actual-umrah-canonical.js';
import type { RollbackRequest, VersionLifecycle } from './version-lifecycle.js';

export type PublicationRecord = (CanonicalHotel | CanonicalRoom | CanonicalRate | CanonicalPeriod | BlankCellLedgerEntry) & { version: string };
export interface MaterializedVersion {
  version: string;
  parentVersion?: string;
  source: VersionLifecycle['manifest']['source'];
  snapshotDigest: string;
  status: 'staging';
  recommenderReady: false;
  versionTags: { version: string; parentVersion?: string };
  hotels: Array<CanonicalHotel & { version: string }>;
  rooms: Array<CanonicalRoom & { version: string }>;
  rates: Array<CanonicalRate & { version: string }>;
  periods: Array<CanonicalPeriod & { version: string }>;
  blankCells: Array<BlankCellLedgerEntry & { version: string }>;
}

export interface PublicationState {
  versions: Record<string, MaterializedVersion>;
  activeVersion?: string;
  cacheVersion: number;
}
export interface PublicationAdapter {
  snapshot(): PublicationState;
  restore(state: PublicationState): void;
  writeVersion(version: MaterializedVersion): void;
  compareAndSetActive(expected: string | undefined, next: string): boolean;
  bumpCache(): void;
}
export interface InMemoryPublicationAdapterOptions {
  events?: string[];
  failAt?: 'write' | 'cas' | 'cache';
  initialState?: PublicationState;
}

export class PublicationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PublicationError';
    this.code = code;
  }
}

function clone<T>(value: T): T { return structuredClone(value); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function serialized(value: unknown): string { return JSON.stringify(stable(value)); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function recordKey(entity: string, record: Record<string, unknown>): string {
  return entity === 'periods' ? `${record.validFrom}\u0000${record.validTo}` : entity === 'blankCells' ? `${record.rowNumber}\u0000${record.column}` : String(record.id);
}
function recordsFor<T extends object>(lifecycle: VersionLifecycle, entity: 'hotels' | 'rooms' | 'rates' | 'periods' | 'blankCells'): T[] {
  const diff = lifecycle.diff[entity];
  const records = [...diff.added.map((item) => item.record as unknown as T), ...diff.changed.map((item) => item.after as unknown as T)];
  const byKey = new Map<string, T>();
  for (const record of records) {
    const key = recordKey(entity, record as Record<string, unknown>);
    const previous = byKey.get(key);
    if (previous && serialized(previous) !== serialized(record)) throw new PublicationError('DUPLICATE_CANDIDATE_RECORD', `${entity} contains conflicting record ${key}`);
    byKey.set(key, clone(stable(record)) as T);
  }
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, record]) => ({ ...record, version: lifecycle.manifest.version } as T));
}

export function materializeVersion(lifecycle: VersionLifecycle): MaterializedVersion {
  // createPublishPlan is the lifecycle's existing approval, digest, and parent-independent gate.
  createPublishPlan(lifecycle, { activeVersion: lifecycle.manifest.parentVersion });
  const version = lifecycle.manifest.version;
  return deepFreeze({
    version,
    ...(lifecycle.manifest.parentVersion === undefined ? {} : { parentVersion: lifecycle.manifest.parentVersion }),
    source: clone(lifecycle.manifest.source),
    snapshotDigest: lifecycle.manifest.snapshotDigest,
    status: 'staging' as const,
    recommenderReady: false as const,
    versionTags: {
      version,
      ...(lifecycle.manifest.parentVersion === undefined ? {} : { parentVersion: lifecycle.manifest.parentVersion }),
    },
    hotels: recordsFor<CanonicalHotel & { version: string }>(lifecycle, 'hotels'),
    rooms: recordsFor<CanonicalRoom & { version: string }>(lifecycle, 'rooms'),
    rates: recordsFor<CanonicalRate & { version: string }>(lifecycle, 'rates'),
    periods: recordsFor<CanonicalPeriod & { version: string }>(lifecycle, 'periods'),
    blankCells: recordsFor<BlankCellLedgerEntry & { version: string }>(lifecycle, 'blankCells'),
  });
}

class MemoryAdapter implements PublicationAdapter {
  private current: PublicationState;
  constructor(private readonly options: InMemoryPublicationAdapterOptions = {}) {
    this.current = clone(options.initialState ?? { versions: {}, activeVersion: undefined, cacheVersion: 0 });
  }
  state(): PublicationState { return clone(this.current); }
  snapshot(): PublicationState { return clone(this.current); }
  restore(state: PublicationState): void { this.current = clone(state); }
  writeVersion(version: MaterializedVersion): void {
    if (this.options.failAt === 'write') throw new PublicationError('ADAPTER_WRITE_FAILED', 'adapter rejected candidate write');
    const existing = this.current.versions[version.version];
    if (existing && serialized(existing) !== serialized(version)) throw new PublicationError('VERSION_CONFLICT', `version ${version.version} already contains a different snapshot`);
    this.current.versions[version.version] = clone(version);
    this.options.events?.push(`write:${version.version}`);
  }
  compareAndSetActive(expected: string | undefined, next: string): boolean {
    if (this.options.failAt === 'cas') throw new PublicationError('ADAPTER_CAS_FAILED', 'adapter compare-and-set failed');
    if (this.current.activeVersion !== expected) return false;
    this.current.activeVersion = next;
    this.options.events?.push(`active:${expected ?? 'none'}->${next}`);
    return true;
  }
  bumpCache(): void {
    if (this.options.failAt === 'cache') throw new PublicationError('ADAPTER_CACHE_FAILED', 'adapter cache bump failed');
    this.current.cacheVersion += 1;
    this.options.events?.push('cache');
  }
}
export function createInMemoryPublicationAdapter(options: InMemoryPublicationAdapterOptions = {}): MemoryAdapter { return new MemoryAdapter(options); }

export interface ExecutePublicationOptions {
  activeVersion?: string;
  rollback?: RollbackRequest;
}
export function executePublication(adapter: PublicationAdapter, lifecycle: VersionLifecycle, options: ExecutePublicationOptions = {}): PublicationState {
  const before = adapter.snapshot();
  try {
    if (options.rollback) {
      const plan = createRollbackPlan(lifecycle, options.rollback);
      if (!before.versions[plan.targetVersion]) throw new PublicationError('NOT_PUBLISHED', 'rollback target has no immutable publication');
      if (before.activeVersion !== plan.expectedActiveVersion) throw new PublicationError('ACTIVE_VERSION_MISMATCH', 'active version changed before rollback');
      if (before.activeVersion === plan.targetVersion) return before;
      if (!adapter.compareAndSetActive(plan.expectedActiveVersion, plan.targetVersion)) throw new PublicationError('ACTIVE_VERSION_MISMATCH', 'active version compare-and-set failed');
      adapter.bumpCache();
      return adapter.snapshot();
    }
    const plan = createPublishPlan(lifecycle, options);
    const candidate = materializeVersion(lifecycle);
    const existing = before.versions[candidate.version];
    if (existing && serialized(existing) !== serialized(candidate)) throw new PublicationError('VERSION_CONFLICT', `version ${candidate.version} already contains a different snapshot`);
    if (before.activeVersion === candidate.version && existing) return before;
    adapter.writeVersion(candidate);
    if (!adapter.compareAndSetActive(plan.expectedActiveVersion, candidate.version)) throw new PublicationError('ACTIVE_VERSION_MISMATCH', 'active version compare-and-set failed');
    adapter.bumpCache();
    return adapter.snapshot();
  } catch (error) {
    adapter.restore(before);
    if (error instanceof PublicationError) throw error;
    throw new PublicationError('PUBLICATION_FAILED', error instanceof Error ? error.message : String(error));
  }
}
