import { describe, expect, it } from 'vitest';
import {
  createInMemoryPublicationStore,
  createReview,
  createVersionLifecycle,
  publishToStore,
  publicationRecordDigest,
  publicationRecordKey,
  serializePublicationStoreState,
} from '../src/index.js';
import type { PublicationStore, StagingDiffResult } from '../src/index.js';

const source = { sourceId: 'candidate', sha256: 'sha', byteLength: 1, rowCount: 1 };
const diff = (version = 'v2', parentVersion?: string, hotelName = 'H'): StagingDiffResult => ({
  version: { ...(parentVersion === undefined ? {} : { parentVersion }), candidateVersion: version }, sources: { candidate: source },
  review: { status: 'pending', approved: false },
  diff: {
    hotels: { added: [{ id: 'hotel-2', record: { id: 'hotel-2', name: hotelName } as never, reasons: ['entity lifecycle'] }], removed: [], changed: [] },
    rooms: { added: [{ id: 'room-2', record: { id: 'room-2', hotelId: 'hotel-2' } as never, reasons: ['entity lifecycle'] }], removed: [], changed: [] },
    rates: { added: [{ id: 'rate-2', record: { id: 'rate-2', hotelId: 'hotel-2' } as never, reasons: ['entity lifecycle'] }], removed: [], changed: [] },
    periods: { added: [{ id: '2026', record: { validFrom: '2026-01-01', validTo: '2026-01-02' } as never, reasons: ['entity lifecycle'] }], removed: [], changed: [] },
    blankCells: { added: [{ id: '1\\u0000DBL', record: { rowNumber: 1, column: 'DBL', rawValue: '', reason: 'unavailable' } as never, reasons: ['entity lifecycle'] }], removed: [], changed: [] },
  },
});
const approved = (version = 'v2', parentVersion: string | null = 'v1', hotelName = 'H') => createReview(createVersionLifecycle(diff(version, parentVersion ?? undefined, hotelName)), {
  status: 'approved', reviewer: 'reviewer', reviewedAt: '2026-11-12T00:00:00.000Z',
});

describe('D1-authoritative, KV-cache-only publication store', () => {
  it('commits candidate, active pointer, history, and cache metadata atomically in order', () => {
    const events: string[] = [];
    const store = createInMemoryPublicationStore({ events, initialState: { versions: {}, activeVersion: 'v1', history: ['v1'], cache: { version: 0, sourceVersion: 'v1' } } });
    const result = publishToStore(store, approved(), { activeVersion: 'v1' });
    expect(result.activeVersion).toBe('v2');
    expect(result.history).toEqual(['v1', 'v2']);
    expect(result.cache).toEqual({ version: 1, sourceVersion: 'v2' });
    expect(events).toEqual(['candidate:v2', 'active:v1->v2', 'history:v2', 'cache:v2']);
    expect(result.versions.v2).toMatchObject({ status: 'staging', recommenderReady: false });
  });

  it('makes identical replay a no-op and rejects same version with different content', () => {
    const store = createInMemoryPublicationStore({ initialState: { versions: {}, activeVersion: 'v1', history: ['v1'], cache: { version: 0, sourceVersion: 'v1' } } });
    const first = publishToStore(store, approved(), { activeVersion: 'v1' });
    expect(publishToStore(store, approved(), { activeVersion: 'v1' })).toEqual(first);
    const conflicting = approved('v2', 'v1', 'different');
    expect(() => publishToStore(store, conflicting, { activeVersion: 'v1' })).toThrow(/VERSION_CONFLICT/);
  });

  it('does not mutate authoritative state on stale CAS or injected transaction failure', () => {
    const initial = { versions: {}, activeVersion: 'v1', history: ['v1'], cache: { version: 0, sourceVersion: 'v1' } };
    const inner = createInMemoryPublicationStore({ initialState: initial });
    const stale: PublicationStore = {
      state: () => inner.state(),
      transaction: (operation) => inner.transaction((transaction) => operation({ ...transaction, compareAndSetActive: (_expected, next) => transaction.compareAndSetActive('drifted', next) })),
    };
    expect(() => publishToStore(stale, approved(), { activeVersion: 'v1' })).toThrow(/ACTIVE_VERSION_MISMATCH/);
    expect(inner.state()).toEqual(initial);
    for (const failAt of ['candidate', 'active', 'history', 'cache'] as const) {
      const store = createInMemoryPublicationStore({ initialState: initial, failAt });
      expect(() => publishToStore(store, approved(), { activeVersion: 'v1' })).toThrow();
      expect(store.state()).toEqual(initial);
    }
  });

  it('rolls back only to an immutable historical version and leaves history unchanged', () => {
    const store = createInMemoryPublicationStore({ initialState: { versions: {}, activeVersion: undefined, history: [], cache: { version: 0 } } });
    publishToStore(store, approved('v1', null), { activeVersion: undefined });
    publishToStore(store, approved('v2'), { activeVersion: 'v1' });
    const before = store.state();
    const result = publishToStore(store, approved('v2'), { rollback: { activeVersion: 'v2', targetVersion: 'v1', previouslyPublished: ['v1', 'v2'] } });
    expect(result.activeVersion).toBe('v1');
    expect(result.history).toEqual(before.history);
    expect(result.versions).toEqual(before.versions);
  });

  it('round-trips a restart and produces deterministic entity keys and digests', () => {
    const store = createInMemoryPublicationStore({ initialState: { versions: {}, activeVersion: 'v1', history: ['v1'], cache: { version: 0, sourceVersion: 'v1' } } });
    const state = publishToStore(store, approved(), { activeVersion: 'v1' });
    const restarted = createInMemoryPublicationStore({ serializedState: serializePublicationStoreState(state) });
    expect(restarted.state()).toEqual(state);
    const records = [['hotels', state.versions.v2.hotels[0]], ['rooms', state.versions.v2.rooms[0]], ['rates', state.versions.v2.rates[0]], ['periods', state.versions.v2.periods[0]], ['blankCells', state.versions.v2.blankCells[0]] ] as const;
    for (const [entity, record] of records) {
      expect(publicationRecordKey('v2', record as unknown as Record<string, unknown>, entity)).toBe(publicationRecordKey('v2', structuredClone(record) as unknown as Record<string, unknown>, entity));
      expect(publicationRecordDigest(record)).toBe(publicationRecordDigest(structuredClone(record)));
    }
  });
});