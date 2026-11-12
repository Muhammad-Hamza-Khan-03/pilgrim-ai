import { describe, expect, it } from 'vitest';
import {
  createInMemoryPublicationAdapter,
  executePublication,
  materializeVersion,
  PublicationError,
} from '../src/index.js';
import { createReview, createVersionLifecycle } from '../src/index.js';
import type { StagingDiffResult } from '../src/index.js';

const source = { sourceId: 'candidate', sha256: 'sha', byteLength: 1, rowCount: 1 };
const diff = (version = 'v2', parentVersion = 'v1'): StagingDiffResult => ({
  version: { parentVersion, candidateVersion: version },
  sources: { candidate: source },
  review: { status: 'pending', approved: false },
  diff: {
    hotels: { added: [{ id: 'hotel-2', record: { id: 'hotel-2', name: 'H' } as never, reasons: ['entity lifecycle'] }], removed: [], changed: [] },
    rooms: { added: [], removed: [], changed: [] },
    rates: { added: [{ id: 'rate-2', record: { id: 'rate-2', hotelId: 'hotel-2' } as never, reasons: ['entity lifecycle'] }], removed: [], changed: [] },
    periods: { added: [{ id: '2026', record: { validFrom: '2026-01-01', validTo: '2026-01-02' } as never, reasons: ['entity lifecycle'] }], removed: [], changed: [] },
    blankCells: { added: [{ id: '1\\u0000DBL', record: { rowNumber: 1, column: 'DBL', rawValue: '', reason: 'unavailable' } as never, reasons: ['entity lifecycle'] }], removed: [], changed: [] },
  },
});
const approved = (version = 'v2', parentVersion = 'v1') => createReview(createVersionLifecycle(diff(version, parentVersion)), {
  status: 'approved', reviewer: 'reviewer', reviewedAt: '2026-11-12T00:00:00.000Z',
});

describe('storage-neutral publication materialization and execution', () => {
  it('materializes a deterministic immutable complete candidate snapshot with version tags', () => {
    const lifecycle = approved();
    const payload = materializeVersion(lifecycle);
    expect(payload).toMatchObject({
      version: 'v2', parentVersion: 'v1', source, snapshotDigest: lifecycle.manifest.snapshotDigest,
      status: 'staging', recommenderReady: false,
      versionTags: { version: 'v2', parentVersion: 'v1' },
    });
    expect(payload.hotels[0]).toMatchObject({ id: 'hotel-2', version: 'v2' });
    expect(payload.rates[0]).toMatchObject({ id: 'rate-2', version: 'v2' });
    expect(payload.periods).toHaveLength(1);
    expect(payload.blankCells).toHaveLength(1);
    expect(lifecycle.diff.hotels.added[0].record).not.toHaveProperty('version');
    expect(materializeVersion(lifecycle)).toEqual(payload);
  });

  it('canonicalizes nested candidate arrays without mutating lifecycle input', () => {
    const leftDiff = diff();
    const rightDiff = diff();
    (leftDiff.diff.hotels.added[0].record as { rooms: Array<{ id: string }> }).rooms = [{ id: 'room-b' }, { id: 'room-a' }];
    (rightDiff.diff.hotels.added[0].record as { rooms: Array<{ id: string }> }).rooms = [{ id: 'room-a' }, { id: 'room-b' }];
    const leftLifecycle = createVersionLifecycle(leftDiff);
    const rightLifecycle = createVersionLifecycle(rightDiff);
    const leftRecord = leftLifecycle.diff.hotels.added[0].record as { rooms: Array<{ id: string }> };
    const left = createReview(leftLifecycle, { status: 'approved', reviewer: 'reviewer', reviewedAt: '2026-11-12T00:00:00.000Z' });
    const right = createReview(rightLifecycle, { status: 'approved', reviewer: 'reviewer', reviewedAt: '2026-11-12T00:00:00.000Z' });
    expect(materializeVersion(left)).toEqual(materializeVersion(right));
    expect(leftRecord.rooms.map((room) => room.id)).toEqual(['room-b', 'room-a']);
  });

  it('rejects unapproved or tampered lifecycles before adapter mutation', () => {
    const adapter = createInMemoryPublicationAdapter();
    expect(() => executePublication(adapter, createVersionLifecycle(diff()), { activeVersion: 'v1' })).toThrow(/REVIEW_NOT_APPROVED/);
    const lifecycle = approved();
    lifecycle.diff.rates.added[0].record = { id: 'rate-2', price: 999 } as never;
    expect(() => executePublication(adapter, lifecycle, { activeVersion: 'v1' })).toThrow(/SNAPSHOT_DIGEST_MISMATCH/);
    expect(adapter.state()).toEqual({ versions: {}, activeVersion: undefined, cacheVersion: 0 });
  });

  it('writes candidate before pointer flip, bumps cache after pointer, and is idempotent', () => {
    const events: string[] = [];
    const adapter = createInMemoryPublicationAdapter({ events, initialState: { versions: {}, activeVersion: 'v1', cacheVersion: 0 } });
    const lifecycle = approved();
    const first = executePublication(adapter, lifecycle, { activeVersion: 'v1' });
    expect(first.activeVersion).toBe('v2');
    expect(events).toEqual(['write:v2', 'active:v1->v2', 'cache']);
    events.length = 0;
    expect(executePublication(adapter, lifecycle, { activeVersion: 'v1' })).toEqual(first);
    expect(events).toEqual([]);
    expect(adapter.state().cacheVersion).toBe(1);
  });

  it('keeps adapter state unchanged when a write, CAS, or cache step fails', () => {
    for (const failure of ['write', 'cas', 'cache'] as const) {
      const adapter = createInMemoryPublicationAdapter({ failAt: failure });
      const before = adapter.state();
      expect(() => executePublication(adapter, approved(), { activeVersion: 'v1' })).toThrow(PublicationError);
      expect(adapter.state()).toEqual(before);
    }
  });

  it('supports rollback only to a previously published immutable version', () => {
    const adapter = createInMemoryPublicationAdapter({ initialState: { versions: {}, activeVersion: 'base', cacheVersion: 0 } });
    executePublication(adapter, approved('v1', 'base'), { activeVersion: 'base' });
    executePublication(adapter, approved('v2'), { activeVersion: 'v1' });
    const before = adapter.state();
    const result = executePublication(adapter, approved('v2'), { rollback: { activeVersion: 'v2', targetVersion: 'v1', previouslyPublished: ['v1', 'v2'] } });
    expect(result.activeVersion).toBe('v1');
    expect(result.versions).toEqual(before.versions);
    expect(result.cacheVersion).toBe(before.cacheVersion + 1);
  });
});
