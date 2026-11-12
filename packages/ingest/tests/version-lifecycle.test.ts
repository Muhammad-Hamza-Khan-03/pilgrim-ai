import { describe, expect, it } from 'vitest';
import {
  createPublishPlan,
  createReview,
  createRollbackPlan,
  createVersionLifecycle,
  serializeVersionLifecycle,
  VersionLifecycleError,
} from '../src/index.js';
import type { StagingDiffResult } from '../src/index.js';

const source = { sourceId: 'toy-source', sha256: 'toy-sha', byteLength: 3, rowCount: 1 };
const toyDiff = (candidateVersion = 'v2'): StagingDiffResult => ({
  version: { parentVersion: 'v1', candidateVersion },
  sources: { parent: source, candidate: { ...source, sourceId: 'toy-candidate' } },
  review: { status: 'pending', approved: false },
  diff: {
    hotels: { added: [], removed: [], changed: [] },
    rooms: { added: [], removed: [], changed: [] },
    rates: { added: [{ id: 'rate-2', record: { id: 'rate-2' } as never, reasons: ['entity lifecycle'] }], removed: [], changed: [] },
    periods: { added: [], removed: [], changed: [] },
    blankCells: { added: [], removed: [], changed: [] },
  },
});

const approved = () => createReview(createVersionLifecycle(toyDiff()), {
  status: 'approved', reviewer: 'reviewer-1', reviewedAt: '2026-11-10T12:00:00.000Z',
});

describe('pure versioned review/publish/rollback lifecycle', () => {
  it('creates an immutable staging manifest with a deterministic digest', () => {
    const lifecycle = createVersionLifecycle(toyDiff());
    expect(lifecycle.manifest).toMatchObject({
      version: 'v2', parentVersion: 'v1', source: { ...source, sourceId: 'toy-candidate' },
      status: 'staging', recommenderReady: false,
    });
    expect(lifecycle.manifest.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycle.review).toEqual({ status: 'pending', approved: false });
    expect(createVersionLifecycle(toyDiff())).toEqual(lifecycle);
  });

  it('is invariant to reordered nested diff arrays and does not mutate input', () => {
    const original = toyDiff();
    const reordered = structuredClone(original);
    reordered.diff.rates.added.reverse();
    expect(createVersionLifecycle(reordered).manifest.snapshotDigest).toBe(createVersionLifecycle(original).manifest.snapshotDigest);
    expect(original.diff.rates.added[0].id).toBe('rate-2');
  });

  it('creates approved and rejected reviews immutably with exact reviewer timestamp validation', () => {
    const lifecycle = createVersionLifecycle(toyDiff());
    const result = createReview(lifecycle, { status: 'approved', reviewer: ' reviewer-1 ', reviewedAt: '2026-11-10T12:00:00.000Z' });
    expect(lifecycle.review).toEqual({ status: 'pending', approved: false });
    expect(result.review).toEqual({ status: 'approved', approved: true, reviewer: 'reviewer-1', reviewedAt: '2026-11-10T12:00:00.000Z', snapshotDigest: lifecycle.manifest.snapshotDigest });
    expect(() => createReview(lifecycle, { status: 'approved', reviewer: '', reviewedAt: '2026-11-10T12:00:00.000Z' })).toThrow(/INVALID_REVIEW/);
    expect(() => createReview(lifecycle, { status: 'approved', reviewer: 'r', reviewedAt: 'not-a-date' })).toThrow(/INVALID_REVIEW/);
    expect(() => createReview(result, { status: 'rejected', reviewer: 'r', reviewedAt: '2026-11-10T12:01:00.000Z' })).toThrow(/REVIEW_TERMINAL/);
  });

  it('requires approval and an optimistic active parent before producing a deterministic upsert plan', () => {
    const lifecycle = approved();
    const plan = createPublishPlan(lifecycle, { activeVersion: 'v1' });
    expect(plan).toEqual({
      version: 'v2', expectedActiveVersion: 'v1',
      upserts: [{ entity: 'rates', id: 'rate-2' }],
      cache: { bump: true },
    });
    expect(createPublishPlan(lifecycle, { activeVersion: 'v1' })).toEqual(plan);
    expect(() => createPublishPlan(createVersionLifecycle(toyDiff()), { activeVersion: 'v1' })).toThrow(/REVIEW_NOT_APPROVED/);
    expect(() => createPublishPlan(lifecycle, { activeVersion: 'other' })).toThrow(/ACTIVE_PARENT_MISMATCH/);
  });

  it('rejects approved content when the lifecycle diff changes after review', () => {
    const lifecycle = approved();
    lifecycle.diff.rates.added[0].record = { id: 'rate-2', price: 999 } as never;
    expect(() => createPublishPlan(lifecycle, { activeVersion: 'v1' })).toThrow(/SNAPSHOT_DIGEST_MISMATCH/);
  });

  it('rejects rejected reviews and only plans rollback to a previously published version', () => {
    const rejected = createReview(createVersionLifecycle(toyDiff()), { status: 'rejected', reviewer: 'r', reviewedAt: '2026-11-10T12:00:00.000Z', reason: 'bad data' });
    expect(() => createPublishPlan(rejected, { activeVersion: 'v1' })).toThrow(/REVIEW_NOT_APPROVED/);
    const lifecycle = approved();
    const plan = createRollbackPlan(lifecycle, { activeVersion: 'v2', targetVersion: 'v1', previouslyPublished: ['v1', 'v2'] });
    expect(plan).toEqual({ targetVersion: 'v1', expectedActiveVersion: 'v2', cache: { bump: true }, historyMutation: false });
    expect(() => createRollbackPlan(lifecycle, { activeVersion: 'v2', targetVersion: 'v0', previouslyPublished: ['v1', 'v2'] })).toThrow(/NOT_PUBLISHED/);
    expect(() => createRollbackPlan(lifecycle, { activeVersion: '', targetVersion: 'v1', previouslyPublished: ['v1'] })).toThrow(/INVALID_VERSION/);
    expect(() => createRollbackPlan(lifecycle, { activeVersion: 'v2', targetVersion: 'v1', previouslyPublished: [''] })).toThrow(/INVALID_VERSION/);
  });

  it('serializes the full lifecycle deterministically', () => {
    const lifecycle = approved();
    expect(serializeVersionLifecycle(lifecycle)).toBe(serializeVersionLifecycle(structuredClone(lifecycle)));
    expect(() => createVersionLifecycle({ ...toyDiff(), version: { parentVersion: '', candidateVersion: 'v2' } })).toThrow(VersionLifecycleError);
    expect(() => createVersionLifecycle({ ...toyDiff(), review: undefined as never })).toThrow(/INVALID_DIFF/);
  });
});
