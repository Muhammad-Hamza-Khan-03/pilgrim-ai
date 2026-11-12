import { createHash } from 'node:crypto';
import { createPublishPlan, createRollbackPlan } from './version-lifecycle.js';
import type { RollbackRequest, VersionLifecycle } from './version-lifecycle.js';
import { materializeVersion } from './publication.js';
import type { MaterializedVersion } from './publication.js';

export interface PublicationCacheMetadata {
  version: number;
  sourceVersion?: string;
}

/** Authoritative publication state. Cache metadata is only a rebuild hint; versions, pointer, and history are authoritative. */
export interface PublicationStoreState {
  versions: Record<string, MaterializedVersion>;
  activeVersion?: string;
  history: string[];
  cache: PublicationCacheMetadata;
}

export interface PublicationTransaction {
  writeCandidate(candidate: MaterializedVersion): void;
  compareAndSetActive(expected: string | undefined, next: string): boolean;
  appendHistory(version: string): void;
  rebuildCacheFromActive(version: string): void;
}

/** Storage-neutral seam matching the atomic unit a D1 transaction will provide. */
export interface PublicationStore {
  transaction<T>(operation: (transaction: PublicationTransaction) => T): T;
  state(): PublicationStoreState;
}

export interface InMemoryPublicationStoreOptions {
  events?: string[];
  failAt?: 'candidate' | 'active' | 'history' | 'cache';
  initialState?: PublicationStoreState;
  serializedState?: string;
}

export class PublicationStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PublicationStoreError';
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

function defaultState(): PublicationStoreState {
  return { versions: {}, activeVersion: undefined, history: [], cache: { version: 0 } };
}

class MemoryPublicationStore implements PublicationStore {
  private current: PublicationStoreState;
  constructor(private readonly options: InMemoryPublicationStoreOptions = {}) {
    this.current = clone(options.serializedState === undefined ? options.initialState ?? defaultState() : JSON.parse(options.serializedState) as PublicationStoreState);
  }
  state(): PublicationStoreState { return clone(this.current); }
  transaction<T>(operation: (transaction: PublicationTransaction) => T): T {
    const working = clone(this.current);
    const events: string[] = [];
    const fail = (point: InMemoryPublicationStoreOptions['failAt']): void => {
      if (this.options.failAt === point) throw new PublicationStoreError('STORE_WRITE_FAILED', `injected ${point} failure`);
    };
    const transaction: PublicationTransaction = {
      writeCandidate: (candidate) => {
        fail('candidate');
        const existing = working.versions[candidate.version];
        if (existing && serialized(existing) !== serialized(candidate)) throw new PublicationStoreError('VERSION_CONFLICT', `version ${candidate.version} already contains different content`);
        working.versions[candidate.version] = clone(candidate);
        events.push(`candidate:${candidate.version}`);
      },
      compareAndSetActive: (expected, next) => {
        fail('active');
        if (working.activeVersion !== expected) return false;
        working.activeVersion = next;
        events.push(`active:${expected ?? 'none'}->${next}`);
        return true;
      },
      appendHistory: (version) => {
        fail('history');
        if (!working.history.includes(version)) working.history.push(version);
        events.push(`history:${version}`);
      },
      rebuildCacheFromActive: (version) => {
        fail('cache');
        working.cache = { version: working.cache.version + 1, sourceVersion: version };
        events.push(`cache:${version}`);
      },
    };
    const result = operation(transaction);
    this.current = working;
    this.options.events?.push(...events);
    return result;
  }
}

export function createInMemoryPublicationStore(options: InMemoryPublicationStoreOptions = {}): MemoryPublicationStore {
  return new MemoryPublicationStore(options);
}

export function serializePublicationStoreState(state: PublicationStoreState): string {
  return JSON.stringify({ versions: stable(state.versions), activeVersion: state.activeVersion, history: [...state.history], cache: stable(state.cache) });
}

function recordIdentity(record: Record<string, unknown>): string {
  if (typeof record.rowNumber === 'number' && typeof record.column === 'string') return `blankCell:${record.rowNumber}\u0000${record.column}`;
  if (typeof record.validFrom === 'string' && typeof record.validTo === 'string') return `period:${record.validFrom}\u0000${record.validTo}`;
  if (typeof record.id === 'string') return `entity:${record.id}`;
  throw new PublicationStoreError('INVALID_RECORD', 'publication records require a deterministic identity');
}

export function publicationRecordKey(version: string, record: Record<string, unknown>, entity?: string): string {
  if (typeof version !== 'string' || version.trim() === '') throw new PublicationStoreError('INVALID_VERSION', 'version must be non-empty');
  return `${version}\u0000${entity ?? 'record'}\u0000${recordIdentity(record)}`;
}

export function publicationRecordDigest(record: unknown): string {
  return createHash('sha256').update(serialized(record)).digest('hex');
}

export interface PublishToStoreOptions {
  activeVersion?: string;
  rollback?: RollbackRequest;
}

export function publishToStore(store: PublicationStore, lifecycle: VersionLifecycle, options: PublishToStoreOptions = {}): PublicationStoreState {
  const before = store.state();
  try {
    if (options.rollback) {
      const plan = createRollbackPlan(lifecycle, options.rollback);
      if (!before.versions[plan.targetVersion]) throw new PublicationStoreError('NOT_PUBLISHED', 'rollback target has no immutable publication');
      if (before.activeVersion !== plan.expectedActiveVersion) throw new PublicationStoreError('ACTIVE_VERSION_MISMATCH', 'active version changed before rollback');
      if (before.activeVersion === plan.targetVersion) return before;
      store.transaction((transaction) => {
        if (!transaction.compareAndSetActive(plan.expectedActiveVersion, plan.targetVersion)) throw new PublicationStoreError('ACTIVE_VERSION_MISMATCH', 'stale active pointer');
        transaction.rebuildCacheFromActive(plan.targetVersion);
      });
      return store.state();
    }

    const plan = createPublishPlan(lifecycle, options);
    const candidate = materializeVersion(lifecycle);
    const existing = before.versions[candidate.version];
    if (existing && serialized(existing) !== serialized(candidate)) throw new PublicationStoreError('VERSION_CONFLICT', `version ${candidate.version} already contains different content`);
    if (existing && before.activeVersion === candidate.version) return before;

    store.transaction((transaction) => {
      transaction.writeCandidate(candidate);
      if (!transaction.compareAndSetActive(plan.expectedActiveVersion, candidate.version)) throw new PublicationStoreError('ACTIVE_VERSION_MISMATCH', 'stale active pointer');
      transaction.appendHistory(candidate.version);
      transaction.rebuildCacheFromActive(candidate.version);
    });
    return store.state();
  } catch (error) {
    if (error instanceof PublicationStoreError) throw error;
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') throw new PublicationStoreError(error.code, error.message);
    throw new PublicationStoreError('PUBLICATION_STORE_FAILED', error instanceof Error ? error.message : String(error));
  }
}
